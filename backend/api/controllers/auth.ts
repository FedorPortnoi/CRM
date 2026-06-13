import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from '../../services/db';
import { auditLog, listAuditEvents } from '../../services/audit';
import {
  createAuthSession,
  listActiveUserSessions,
  revokeAllUserSessions,
  revokeAuthSession,
} from '../../services/sessions';
import { issueCode, verifyCode } from '../../services/verification';
import { sendOtp, isSmsSendingEnabled } from '../../services/sms';
import { sendEmail, isEmailSendingEnabled } from '../../services/email';

const saltRounds = process.env.NODE_ENV === 'test' ? 4 : 12;

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// Pre-computed dummy hash — always run bcrypt to prevent timing-based email enumeration.
const DUMMY_HASH = '$2b$12$invalidhashfortimingprotectio.AAAAAAAAAAAAAAAAAAAAAAAA';

type AuthRole = 'owner' | 'admin' | 'member' | 'viewer';

type AuthUserListItem = {
  id: string;
  email: string | null;
  username: string | null;
  name: string;
  role: string;
};

type AuthUsersResponse = {
  data: AuthUserListItem[];
  meta: {
    total: number;
  };
};

type AuditQuery = {
  action?: string;
  outcome?: string;
  user_id?: string;
  start?: string;
  end?: string;
  page: number;
  per_page: number;
};

function onboardingCompleted(state: Prisma.JsonValue | null): boolean {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return false;
  }

  const record = state as Record<string, unknown>;
  return record.completed === true || typeof record.completed_at === 'string';
}

function publicUser(user: { id: string; email: string | null; username?: string | null; name: string; role: string; organization_id: string; onboarding_state?: Prisma.JsonValue | null; must_change_password?: boolean; must_change_email?: boolean }) {
  return {
    id: user.id,
    email: user.email,
    username: user.username ?? null,
    name: user.name,
    role: user.role,
    org_id: user.organization_id,
    onboarding_completed: onboardingCompleted(user.onboarding_state ?? null),
    must_change_password: user.must_change_password ?? false,
    must_change_email: user.must_change_email ?? false,
  };
}

function generateSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

// Rotating company join code: a readable company prefix + a short random suffix.
const JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateJoinCode(orgName: string): string {
  const prefix = orgName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 16) || 'TEAM';
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
  return `${prefix}-${suffix}`;
}

// Returns the org's current code, regenerating it first if missing or past its TTL.
async function ensureFreshJoinCode(org: {
  id: string;
  name: string;
  join_code: string | null;
  join_code_expires_at: Date | null;
}): Promise<{ join_code: string; join_code_expires_at: Date }> {
  const expired = !org.join_code || !org.join_code_expires_at || org.join_code_expires_at <= new Date();
  if (!expired) {
    return { join_code: org.join_code!, join_code_expires_at: org.join_code_expires_at! };
  }
  const join_code = generateJoinCode(org.name);
  const join_code_expires_at = new Date(Date.now() + JOIN_CODE_TTL_MS);
  await db.org.update({ where: { id: org.id }, data: { join_code, join_code_expires_at } });
  return { join_code, join_code_expires_at };
}

// Build a unique-within-org username from a person's name (e.g. "Ivan Petrov", "Ivan Petrov 2").
async function uniqueUsernameForOrg(orgId: string, baseName: string): Promise<string> {
  const base = baseName.replace(/\s+/g, ' ').trim();
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base} ${attempt + 1}`;
    const existing = await db.user.findFirst({
      where: { organization_id: orgId, username: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  // Extremely unlikely fallback.
  return `${base} ${crypto.randomBytes(2).toString('hex')}`;
}

function invalidCredentials(reply: FastifyReply) {
  return reply.code(401).send({
    error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function signSessionToken(
  request: FastifyRequest,
  reply: FastifyReply,
  user: { id: string; organization_id: string; role: AuthRole },
): Promise<string> {
  const expiresIn = process.env.JWT_EXPIRES_IN ?? '7d';
  const sessionId = await createAuthSession({
    request,
    userId: user.id,
    organizationId: user.organization_id,
    expiresIn,
  });

  const token = await reply.jwtSign(
    { sub: user.id, org_id: user.organization_id, role: user.role, sid: sessionId },
    { expiresIn },
  );
  return token;
}

export const AuthController = {
  register: async (request: FastifyRequest, reply: FastifyReply) => {
    const { email: rawEmail, password, name, org_name, phone } = request.body as {
      email: string;
      password: string;
      name: string;
      org_name: string;
      phone: string;
    };
    const email = normalizeEmail(rawEmail);

    try {
      const [password_hash, slug] = await Promise.all([
        bcrypt.hash(password, saltRounds),
        Promise.resolve(generateSlug(org_name)),
      ]);
      const join_code = generateJoinCode(org_name);
      const join_code_expires_at = new Date(Date.now() + JOIN_CODE_TTL_MS);

      // Single SQL CTE: org + user + owner_id update + pipeline + stages in one round-trip.
      // The circular FK (org.owner_id → user, user.organization_id → org) is broken by
      // inserting org with owner_id=NULL first, then updating once we have the user id.
      const rows = await db.$queryRaw<Array<{ org_id: string; user_id: string }>>`
        WITH
          org_cte AS (
            INSERT INTO organizations (name, slug, plan, join_code, join_code_expires_at, updated_at)
            VALUES (${org_name}, ${slug}, 'starter'::"OrgPlan", ${join_code}, ${join_code_expires_at}, NOW())
            RETURNING id
          ),
          user_cte AS (
            INSERT INTO "User" (organization_id, email, password_hash, name, role, phone, updated_at)
            SELECT id, ${email}, ${password_hash}, ${name}, 'owner'::"UserRole", ${phone}, NOW()
            FROM org_cte
            RETURNING id
          ),
          owner_update AS (
            UPDATE organizations
            SET owner_id = (SELECT id FROM user_cte), updated_at = NOW()
            WHERE id = (SELECT id FROM org_cte)
            RETURNING id
          ),
          pipeline_cte AS (
            INSERT INTO "Pipeline" (organization_id, name, is_default, created_by, updated_at)
            SELECT org_cte.id, 'Sales Pipeline', true, user_cte.id, NOW()
            FROM org_cte, user_cte
            RETURNING id
          ),
          stage_cte AS (
            INSERT INTO "PipelineStage" (pipeline_id, name, position, is_won_stage, updated_at)
            SELECT
              (SELECT id FROM pipeline_cte),
              unnest(ARRAY['Lead','Qualified','Proposal','Closed Won']),
              unnest(ARRAY[0,1,2,3]),
              unnest(ARRAY[false,false,false,true]),
              NOW()
            RETURNING id
          )
        SELECT
          (SELECT id FROM org_cte)   AS org_id,
          (SELECT id FROM user_cte)  AS user_id,
          (SELECT COUNT(*)::int FROM stage_cte) AS _s
      `;

      const { org_id, user_id } = rows[0];

      await auditLog({
        action: 'auth.register',
        outcome: 'success',
        request,
        organizationId: org_id,
        userId: user_id,
        metadata: { email },
      });

      // Issue OTPs — delivery failure must not crash registration; account was already committed.
      // Client should call POST /auth/verify/resend if sms_sent and email_sent are both false.
      let smsDelivered = false;
      let emailDelivered = false;
      try {
        const [smsCode, emailCode] = await Promise.all([
          issueCode(user_id, 'sms'),
          issueCode(user_id, 'email'),
        ]);
        const [smsResult, emailResult] = await Promise.all([
          isSmsSendingEnabled() ? sendOtp(phone, smsCode) : Promise.resolve({ success: false }),
          isEmailSendingEnabled() ? sendEmail(email, 'Код подтверждения', `Ваш код: ${emailCode}. Действителен 10 минут.`) : Promise.resolve({ success: false }),
        ]);
        smsDelivered = smsResult.success;
        emailDelivered = emailResult.success;
      } catch {
        // silent — user can resend
      }

      return reply.code(201).send({
        data: { user_id, email, needs_verification: true },
        meta: { sms_sent: smsDelivered, email_sent: emailDelivered },
      });
    } catch (err: unknown) {
      const errCode = (err as { code?: string })?.code;
      const rawQueryCode = (err as { meta?: { code?: string } })?.meta?.code;
      const errMessage = (err as { message?: string })?.message ?? '';
      if (
        (err instanceof Prisma.PrismaClientKnownRequestError && errCode === 'P2002') ||
        errCode === '23505' ||
        rawQueryCode === '23505' ||
        (errCode === 'P2010' && (errMessage.includes('23505') || errMessage.includes('duplicate key')))
      ) {
        await auditLog({
          action: 'auth.register',
          outcome: 'failure',
          request,
          metadata: { email, reason: 'duplicate_email' },
        });
        return reply.code(409).send({
          error: { code: 'EMAIL_ALREADY_EXISTS', message: 'An account with this email already exists' },
        });
      }
      throw err;
    }
  },

  login: async (request: FastifyRequest, reply: FastifyReply) => {
    const { email: rawEmail, password } = request.body as { email: string; password: string };
    const email = normalizeEmail(rawEmail);

    const user = await db.user.findUnique({ where: { email } });

    // Always run bcrypt regardless of whether user exists — prevents timing-based email enumeration.
    const hashToCompare = user?.password_hash ?? DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, hashToCompare);

    // Check account lockout before revealing any other reason for failure.
    if (user && user.locked_until && user.locked_until > new Date()) {
      await auditLog({
        action: 'auth.login',
        outcome: 'failure',
        request,
        organizationId: user.organization_id,
        userId: user.id,
        metadata: { email, reason: 'account_locked' },
      });
      return invalidCredentials(reply);
    }

    const isValidLogin = user !== null && user.is_active && user.is_verified && passwordMatches;

    if (user && !user.is_verified && passwordMatches && user.is_active) {
      return reply.code(403).send({
        error: { code: 'ACCOUNT_NOT_VERIFIED', message: 'Please verify your account via the code sent to your phone and email.' },
      });
    }

    if (!isValidLogin) {
      const reason = !user ? 'unknown_email' : !user.is_active ? 'inactive_user' : 'invalid_password';

      if (user) {
        const newCount = user.failed_login_count + 1;
        const shouldLock = newCount >= MAX_FAILED_ATTEMPTS;
        await db.user.update({
          where: { id: user.id },
          data: {
            failed_login_count: newCount,
            ...(shouldLock ? { locked_until: new Date(Date.now() + LOCKOUT_DURATION_MS) } : {}),
          },
        });
      }

      await auditLog({
        action: 'auth.login',
        outcome: 'failure',
        request,
        organizationId: user?.organization_id,
        userId: user?.id,
        metadata: { email, reason },
      });
      return invalidCredentials(reply);
    }

    // Reset lockout state on successful login.
    await db.user.update({
      where: { id: user.id },
      data: { failed_login_count: 0, locked_until: null },
    });

    const token = await signSessionToken(request, reply, { ...user, role: user.role as AuthRole });

    await auditLog({
      action: 'auth.login',
      outcome: 'success',
      request,
      organizationId: user.organization_id,
      userId: user.id,
      metadata: { email },
    });

    return reply.send({
      data: {
        user: publicUser(user),
        token,
      },
      meta: {},
    });
  },

  logout: async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.user.sid;
    if (!sessionId) {
      await auditLog({
        action: 'auth.logout',
        outcome: 'failure',
        request,
        metadata: { reason: 'missing_session_id' },
      });
      return reply.status(401).send({
        error: { code: 'SESSION_REQUIRED', message: 'Authentication session is required' },
      });
    }

    const revokedCount = await revokeAuthSession(
      sessionId,
      request.user.sub,
      request.user.org_id,
      'user_logout',
    );

    await auditLog({
      action: 'auth.logout',
      outcome: revokedCount === 1 ? 'success' : 'failure',
      request,
      metadata: { revoked_count: revokedCount },
    });

    return reply.send({ data: { revoked: revokedCount === 1 }, meta: {} });
  },

  logoutAll: async (request: FastifyRequest, reply: FastifyReply) => {
    const revokedCount = await revokeAllUserSessions(
      request.user.sub,
      request.user.org_id,
      'user_logout_all',
    );

    await auditLog({
      action: 'auth.logout_all',
      outcome: 'success',
      request,
      metadata: { revoked_count: revokedCount },
    });

    return reply.send({ data: { revoked_count: revokedCount }, meta: {} });
  },

  listSessions: async (request: FastifyRequest, reply: FastifyReply) => {
    const sessions = await listActiveUserSessions(request.user.sub, request.user.org_id);
    return reply.send({
      data: sessions.map((session) => ({
        ...session,
        current: request.user.sid === session.id,
      })),
      meta: { total: sessions.length },
    });
  },

  listAuditEvents: async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as AuditQuery;
    const { data, total } = await listAuditEvents({
      organizationId: request.user.org_id,
      action: query.action,
      outcome: query.outcome,
      userId: query.user_id,
      start: query.start ? new Date(query.start) : undefined,
      end: query.end ? new Date(query.end) : undefined,
      page: query.page,
      perPage: query.per_page,
    });

    await auditLog({
      action: 'audit.read',
      outcome: 'success',
      request,
      metadata: {
        filters: {
          action: query.action,
          outcome: query.outcome,
          user_id: query.user_id,
          start: query.start,
          end: query.end,
        },
        result_count: data.length,
      },
    });

    return reply.send({
      data,
      meta: {
        total,
        page: query.page,
        per_page: query.per_page,
      },
    });
  },

  listUsers: async (request: FastifyRequest, reply: FastifyReply) => {
    const users = await db.user.findMany({
      where: {
        organization_id: request.user.org_id,
        is_active: true,
      },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        role: true,
      },
      orderBy: { name: 'asc' },
    });

    const response: AuthUsersResponse = {
      data: users,
      meta: { total: users.length },
    };

    return reply.send(response);
  },

  getOnboarding: async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await db.user.findFirst({
      where: { id: request.user.sub, organization_id: request.user.org_id },
      select: { onboarding_state: true },
    });

    return reply.send({
      data: user?.onboarding_state ?? { completed: false },
      meta: {},
    });
  },

  updateOnboarding: async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { completed?: boolean; dismissed_steps?: string[] };
    const state = {
      completed: body.completed ?? false,
      dismissed_steps: body.dismissed_steps ?? [],
      completed_at: body.completed ? new Date().toISOString() : undefined,
    };

    const user = await db.user.update({
      where: { id: request.user.sub, organization_id: request.user.org_id },
      data: { onboarding_state: state },
    });

    return reply.send({
      data: publicUser(user),
      meta: {},
    });
  },

  inviteUser: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only owners and admins can invite members' } });
    }

    const { first_name, last_name, role } = request.body as { first_name: string; last_name: string; role: AuthRole };

    const validRoles: AuthRole[] = ['admin', 'member', 'viewer'];
    if (!validRoles.includes(role)) {
      return reply.status(400).send({ error: { code: 'INVALID_ROLE', message: 'Role must be admin, member, or viewer' } });
    }
    if (callerRole === 'admin' && role === 'admin') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Admins cannot invite other admins' } });
    }

    const firstName = (first_name ?? '').trim();
    const lastName = (last_name ?? '').trim();
    if (firstName === '' || lastName === '') {
      return reply.status(400).send({ error: { code: 'INVALID_NAME', message: 'First and last name are required' } });
    }

    const fullName = `${firstName} ${lastName}`;
    const username = await uniqueUsernameForOrg(request.user.org_id, fullName);

    const tempPassword = crypto.randomBytes(16).toString('base64url');
    const hashedPassword = await bcrypt.hash(tempPassword, saltRounds);

    const user = await db.user.create({
      data: {
        username,
        name: fullName,
        password_hash: hashedPassword,
        role,
        organization_id: request.user.org_id,
        is_active: true,
        is_verified: true,
        must_change_password: true,
        must_change_email: true,
      },
      select: { id: true, username: true, name: true, role: true },
    });

    // Surface the (possibly freshly-rotated) company code so the owner can hand everything over at once.
    const org = await db.org.findUnique({
      where: { id: request.user.org_id },
      select: { id: true, name: true, join_code: true, join_code_expires_at: true },
    });
    const code = org ? await ensureFreshJoinCode(org) : null;

    return reply.status(201).send({
      data: {
        ...user,
        temp_password: tempPassword,
        company_code: code?.join_code ?? null,
      },
      meta: {},
    });
  },

  // Resolve org by a valid (non-expired) company code, then the employee by username within it.
  join: async (request: FastifyRequest, reply: FastifyReply) => {
    const { company_code, username, password } = request.body as { company_code: string; username: string; password: string };

    const org = await db.org.findFirst({
      where: { join_code: company_code.trim() },
      select: { id: true, join_code_expires_at: true },
    });

    if (!org || !org.join_code_expires_at || org.join_code_expires_at <= new Date()) {
      await auditLog({ action: 'auth.join', outcome: 'failure', request, metadata: { reason: 'invalid_or_expired_code' } });
      return reply.code(401).send({ error: { code: 'INVALID_JOIN', message: 'Invalid company code, username, or password' } });
    }

    const user = await db.user.findFirst({
      where: { organization_id: org.id, username: username.trim() },
    });

    const hashToCompare = user?.password_hash ?? DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, hashToCompare);

    if (!user || !user.is_active || !passwordMatches) {
      await auditLog({ action: 'auth.join', outcome: 'failure', request, organizationId: org.id, userId: user?.id, metadata: { reason: 'invalid_credentials' } });
      return reply.code(401).send({ error: { code: 'INVALID_JOIN', message: 'Invalid company code, username, or password' } });
    }

    const token = await signSessionToken(request, reply, { ...user, role: user.role as AuthRole });

    await auditLog({ action: 'auth.join', outcome: 'success', request, organizationId: org.id, userId: user.id });

    return reply.send({ data: { user: publicUser(user), token }, meta: {} });
  },

  // Owner/admin view of the current rotating company code (regenerates lazily if expired).
  getCompanyCode: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only owners and admins can view the company code' } });
    }
    const org = await db.org.findUnique({
      where: { id: request.user.org_id },
      select: { id: true, name: true, join_code: true, join_code_expires_at: true },
    });
    if (!org) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    }
    const code = await ensureFreshJoinCode(org);
    return reply.send({ data: { company_code: code.join_code, expires_at: code.join_code_expires_at }, meta: {} });
  },

  // Owner-triggered early rotation.
  rotateCompanyCode: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only owners and admins can rotate the company code' } });
    }
    const org = await db.org.findUnique({ where: { id: request.user.org_id }, select: { name: true } });
    if (!org) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    }
    const join_code = generateJoinCode(org.name);
    const join_code_expires_at = new Date(Date.now() + JOIN_CODE_TTL_MS);
    await db.org.update({ where: { id: request.user.org_id }, data: { join_code, join_code_expires_at } });
    await auditLog({ action: 'auth.rotate_company_code', outcome: 'success', request, organizationId: request.user.org_id, userId: request.user.sub });
    return reply.send({ data: { company_code: join_code, expires_at: join_code_expires_at }, meta: {} });
  },

  // First-login setup: employee sets their own email + new password, clearing both flags.
  setCredentials: async (request: FastifyRequest, reply: FastifyReply) => {
    const { email: rawEmail, new_password } = request.body as { email: string; new_password: string };
    const email = normalizeEmail(rawEmail);

    const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (existing && existing.id !== request.user.sub) {
      return reply.status(409).send({ error: { code: 'EMAIL_ALREADY_EXISTS', message: 'An account with this email already exists' } });
    }

    const newHash = await bcrypt.hash(new_password, saltRounds);
    const user = await db.user.update({
      where: { id: request.user.sub },
      data: { email, password_hash: newHash, email_verified: true, must_change_password: false, must_change_email: false },
    });

    await auditLog({ action: 'auth.set_credentials', outcome: 'success', request, organizationId: request.user.org_id, userId: request.user.sub, metadata: { email } });

    return reply.send({ data: { user: publicUser(user) }, meta: {} });
  },

  deactivateUser: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only owners and admins can deactivate members' } });
    }

    const { id } = request.params as { id: string };
    if (id === request.user.sub) {
      return reply.status(400).send({ error: { code: 'CANNOT_DEACTIVATE_SELF', message: 'You cannot deactivate your own account' } });
    }

    const target = await db.user.findFirst({
      where: { id, organization_id: request.user.org_id },
      select: { id: true, role: true, is_active: true },
    });
    if (!target) {
      return reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }
    if (target.role === 'owner' && callerRole !== 'owner') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only the owner can deactivate another owner' } });
    }

    await db.user.update({ where: { id }, data: { is_active: false } });
    return reply.send({ data: { id }, meta: {} });
  },

  changeUserRole: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    if (callerRole !== 'owner') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only owners can change user roles' } });
    }

    const { id } = request.params as { id: string };
    if (id === request.user.sub) {
      return reply.status(400).send({ error: { code: 'CANNOT_CHANGE_OWN_ROLE', message: 'You cannot change your own role' } });
    }

    const { role } = request.body as { role: AuthRole };
    const assignableRoles: AuthRole[] = ['admin', 'member', 'viewer'];
    if (!assignableRoles.includes(role)) {
      return reply.status(400).send({ error: { code: 'INVALID_ROLE', message: 'Role must be admin, member, or viewer' } });
    }

    const target = await db.user.findFirst({
      where: { id, organization_id: request.user.org_id },
      select: { id: true },
    });
    if (!target) {
      return reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }

    const updated = await db.user.update({ where: { id }, data: { role }, select: { id: true, role: true } });
    return reply.send({ data: updated, meta: {} });
  },

  verifyOtp: async (request: FastifyRequest, reply: FastifyReply) => {
    const { user_id, code, channel } = request.body as { user_id: string; code: string; channel: 'sms' | 'email' };

    const user = await db.user.findUnique({
      where: { id: user_id },
      select: { id: true, email: true, name: true, role: true, organization_id: true, is_verified: true, is_active: true },
    });

    if (!user || !user.is_active) {
      return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }

    if (user.is_verified) {
      return reply.code(409).send({ error: { code: 'ALREADY_VERIFIED', message: 'Account is already verified' } });
    }

    const valid = await verifyCode(user_id, code, channel);
    if (!valid) {
      await auditLog({
        action: 'auth.verify_otp',
        outcome: 'failure',
        request,
        organizationId: user.organization_id,
        userId: user_id,
        metadata: { channel, reason: 'invalid_or_expired_code' },
      });
      return reply.code(400).send({ error: { code: 'INVALID_CODE', message: 'Code is invalid or has expired' } });
    }

    const verificationUpdate =
      channel === 'sms'
        ? { phone_verified: true, is_verified: true }
        : { email_verified: true, is_verified: true };

    await db.user.update({ where: { id: user_id }, data: verificationUpdate });

    await auditLog({
      action: 'auth.verify_otp',
      outcome: 'success',
      request,
      organizationId: user.organization_id,
      userId: user_id,
      metadata: { channel },
    });

    const token = await signSessionToken(request, reply, {
      id: user.id,
      organization_id: user.organization_id,
      role: user.role as AuthRole,
    });

    return reply.code(200).send({
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role, org_id: user.organization_id, onboarding_completed: false },
        token,
      },
      meta: {},
    });
  },

  changePassword: async (request: FastifyRequest, reply: FastifyReply) => {
    const { new_password } = request.body as { new_password: string };

    const newHash = await bcrypt.hash(new_password, saltRounds);
    await db.user.update({
      where: { id: request.user.sub },
      data: { password_hash: newHash, must_change_password: false },
    });

    await auditLog({
      action: 'auth.change_password',
      outcome: 'success',
      request,
      organizationId: request.user.org_id,
      userId: request.user.sub,
      metadata: {},
    });

    return reply.send({ data: { updated: true }, meta: {} });
  },

  resendVerification: async (request: FastifyRequest, reply: FastifyReply) => {
    const { user_id, channel } = request.body as { user_id: string; channel: 'sms' | 'email' };

    const user = await db.user.findUnique({
      where: { id: user_id },
      select: { id: true, email: true, phone: true, is_verified: true, is_active: true },
    });

    if (!user || !user.is_active) {
      return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }

    if (user.is_verified) {
      return reply.code(409).send({ error: { code: 'ALREADY_VERIFIED', message: 'Account is already verified' } });
    }

    const code = await issueCode(user_id, channel);

    if (channel === 'sms') {
      if (!user.phone) {
        return reply.code(400).send({ error: { code: 'PHONE_MISSING', message: 'No phone number on file' } });
      }
      await sendOtp(user.phone, code);
    } else {
      if (!user.email) {
        return reply.code(400).send({ error: { code: 'EMAIL_MISSING', message: 'No email on file' } });
      }
      await sendEmail(user.email, 'Код подтверждения', `Ваш код: ${code}. Действителен 10 минут.`);
    }

    return reply.code(200).send({ data: { sent: true }, meta: {} });
  },
};
