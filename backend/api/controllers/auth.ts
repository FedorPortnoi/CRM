import { assignableRoles, can, isAdminLevelRole, isRole } from '../../services/capabilities';
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
import { sendEmail, isEmailSendingEnabled } from '../../services/email';
import {
  DEFAULT_PIPELINE_NAME,
  DEFAULT_PIPELINE_STAGE_NAMES,
  DEFAULT_TIME_ZONE,
} from '../../config/market';
import { requiresEmailVerification } from '../../config/security';
import { consumeScopedBudget } from '../../services/rate-limit-store';

const saltRounds = process.env.NODE_ENV === 'test' ? 4 : 12;

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// Compute a valid dummy hash once so absent-user checks still perform a full bcrypt comparison.
const DUMMY_HASH = bcrypt.hashSync('a-non-secret-placeholder', saltRounds);

type AuthRole = string;

/**
 * THE TEAM-ADMIN DENIAL MESSAGES, one per handler.
 *
 * Exported and byte-identical to the `reason` strings in adminRoutePolicy
 * (api/authenticate.ts), because the preHandler now answers first for these
 * routes and no client should see the text change — src/app/settings/team.tsx
 * renders `json.error.message` straight into an Alert. Both sides are pinned by
 * tests/unit/backend/auth-team-admin-authz.test.ts so they cannot drift, exactly
 * as SEQUENCE_ADMIN_DENIAL_MESSAGE is in controllers/sequences.ts.
 *
 * The controller checks stay even though the preHandler now covers the same
 * routes. Two doors is this codebase's stated pattern: the preHandler exists to
 * AUDIT the denial, the controller to fail closed if a route is ever remounted
 * somewhere the path table does not describe.
 */
export const TEAM_DENIAL_MESSAGES = {
  invite: 'Only owners and admins can invite members',
  deactivate: 'Only owners and admins can deactivate members',
  setManager: 'Only owners and admins can assign managers',
  changeRole: 'Only owners can change user roles',
  readCompanyCode: 'Only owners and admins can view the company code',
  rotateCompanyCode: 'Only owners and admins can rotate the company code',
} as const;

/**
 * "Modify an admin-level member" is owner-only — CAPABILITIES says so in the
 * definition of team.manage_admins. The code did not: deactivateUser compared
 * `target.role === 'owner'`, so an admin could deactivate a PEER admin (locking
 * them out of the whole product on their next request) and setUserManager did not
 * fetch the target's role at all, so an admin could reparent the OWNER under a
 * `head` and hand that head the owner's entire book through the visibility cone.
 * Both wrote no audit row.
 *
 * Asked of the capability map rather than of a string, so the guard covers any
 * future role granted team.manage.
 */
function refuseAdminLevelTarget(
  callerRole: AuthRole,
  targetRole: string,
): string | null {
  if (isAdminLevelRole(targetRole) && !can(callerRole, 'team.manage_admins')) {
    return 'Only the owner can modify an owner or admin';
  }
  return null;
}

type PasswordAttemptUser = {
  id: string;
  password_hash: string;
  failed_login_count: number;
  locked_until: Date | null;
  is_active: boolean;
  is_verified: boolean;
};

type PasswordAttemptOutcome = 'success' | 'failure' | 'non_counted_failure';
type PasswordAttemptResult = PasswordAttemptOutcome | 'locked';

type AuthUserListItem = {
  id: string;
  email: string | null;
  username: string | null;
  name: string;
  role: string;
  manager_id: string | null;
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

function publicUser(user: { id: string; email: string | null; username?: string | null; name: string; role: string; organization_id: string; timezone?: string; onboarding_state?: Prisma.JsonValue | null; must_change_password?: boolean; must_change_email?: boolean; manager_id?: string | null }) {
  return {
    id: user.id,
    email: user.email,
    username: user.username ?? null,
    name: user.name,
    role: user.role,
    org_id: user.organization_id,
    timezone: user.timezone ?? DEFAULT_TIME_ZONE,
    manager_id: user.manager_id ?? null,
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
export async function uniqueUsernameForOrg(orgId: string, baseName: string): Promise<string> {
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

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function verifyPasswordWithLockout(
  user: PasswordAttemptUser | null,
  password: string,
  classify: (candidate: PasswordAttemptUser, passwordMatches: boolean) => PasswordAttemptOutcome,
): Promise<PasswordAttemptResult> {
  // The compare runs FIRST, before the lockout branch, and its result is
  // discarded on the locked path. Returning early on `locked` skipped bcrypt
  // entirely, so a locked account answered in ~5 ms where every other rejection
  // took ~300 ms — a ~60x timing gap behind an identical INVALID_CREDENTIALS
  // body, which told an attacker both that the address exists and that someone
  // has been guessing it. Same reason `user` may be null here: an unknown email
  // still pays for a DUMMY_HASH compare so absent and present cost the same.
  const passwordMatches = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);

  if (user?.locked_until && user.locked_until > new Date()) {
    return 'locked';
  }
  if (!user) {
    return 'failure';
  }

  const outcome = classify(user, passwordMatches);
  if (outcome === 'failure') {
    const failedAttempt = await db.user.update({
      where: { id: user.id },
      data: { failed_login_count: { increment: 1 } },
      select: { failed_login_count: true },
    });
    if (failedAttempt.failed_login_count >= MAX_FAILED_ATTEMPTS) {
      await db.user.update({
        where: { id: user.id },
        data: { locked_until: new Date(Date.now() + LOCKOUT_DURATION_MS) },
      });
    }
  } else if (outcome === 'success') {
    await db.user.update({
      where: { id: user.id },
      data: { failed_login_count: 0, locked_until: null },
    });
  }

  return outcome;
}

export async function signSessionToken(
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
            SELECT org_cte.id, ${DEFAULT_PIPELINE_NAME}, true, user_cte.id, NOW()
            FROM org_cte, user_cte
            RETURNING id
          ),
          stage_cte AS (
            INSERT INTO "PipelineStage" (pipeline_id, name, position, is_won_stage, updated_at)
            SELECT
              (SELECT id FROM pipeline_cte),
              unnest(ARRAY[${Prisma.join(DEFAULT_PIPELINE_STAGE_NAMES)}]::text[]),
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

      // Issue the OTP — delivery failure must not crash registration; account was already committed.
      // Client should call POST /auth/verify/resend if email_sent is false.
      let emailDelivered = false;
      try {
        const emailCode = await issueCode(user_id, 'email');
        const emailResult = isEmailSendingEnabled()
          ? await sendEmail(email, 'Код подтверждения', `Ваш код: ${emailCode}. Действителен 10 минут.`)
          : { success: false };
        emailDelivered = emailResult.success;
      } catch {
        // silent — user can resend
      }

      return reply.code(201).send({
        data: { user_id, email, needs_verification: true },
        meta: { email_sent: emailDelivered },
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

    const credentialStatus = await verifyPasswordWithLockout(user, password, (candidate, passwordMatches) => {
      if (candidate.is_active && candidate.is_verified && passwordMatches) {
        return 'success';
      }
      if (candidate.is_active && !candidate.is_verified && passwordMatches) {
        return 'non_counted_failure';
      }
      return 'failure';
    });

    // Check account lockout before revealing any other reason for failure.
    if (credentialStatus === 'locked' && user) {
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

    if (credentialStatus === 'non_counted_failure') {
      return reply.code(403).send({
        error: { code: 'ACCOUNT_NOT_VERIFIED', message: 'Please verify your account via the code sent to your phone and email.' },
      });
    }

    if (credentialStatus !== 'success' || !user) {
      const reason = !user ? 'unknown_email' : !user.is_active ? 'inactive_user' : 'invalid_password';

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
    const callerRole = request.user.role as AuthRole;
    // Which roles see teammates' addresses is an authorization decision, so it
    // asks the capability map like every other one. Identical holder set to the
    // `owner || admin` string pair it replaces, for all eight roles.
    const includeEmails = can(callerRole, 'team.manage');

    const users = await db.user.findMany({
      where: {
        organization_id: request.user.org_id,
        is_active: true,
      },
      select: {
        id: true,
        email: includeEmails,
        username: true,
        name: true,
        role: true,
        manager_id: true,
      },
      orderBy: { name: 'asc' },
    });

    const response: AuthUsersResponse = {
      data: users as AuthUserListItem[],
      meta: { total: users.length },
    };

    return reply.send(response);
  },

  inviteUser: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    if (!can(callerRole, 'team.manage')) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: TEAM_DENIAL_MESSAGES.invite } });
    }

    const { first_name, last_name, role } = request.body as { first_name: string; last_name: string; role: AuthRole };

    // assignableRoles() already excludes `admin` unless the caller holds
    // team.manage_admins, so the "admins cannot mint admins" rule is expressed
    // once in the capability map rather than as a second, separate check that
    // could drift away from it.
    const validRoles = assignableRoles(callerRole);
    if (!isRole(role) || !validRoles.includes(role)) {
      return reply.status(400).send({
        error: { code: 'INVALID_ROLE', message: `Role must be one of: ${validRoles.join(', ')}` },
      });
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

    await auditLog({
      action: 'team.invite_member',
      outcome: 'success',
      request,
      organizationId: request.user.org_id,
      userId: request.user.sub,
      targetType: 'user',
      targetId: user.id,
      metadata: { role },
    });

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

    const credentialStatus = await verifyPasswordWithLockout(user, password, (candidate, passwordMatches) => (
      candidate.is_active && passwordMatches ? 'success' : 'failure'
    ));

    if (credentialStatus === 'locked') {
      await auditLog({ action: 'auth.join', outcome: 'failure', request, organizationId: org.id, userId: user?.id, metadata: { reason: 'account_locked' } });
      return reply.code(401).send({ error: { code: 'INVALID_JOIN', message: 'Invalid company code, username, or password' } });
    }

    if (credentialStatus !== 'success' || !user) {
      await auditLog({ action: 'auth.join', outcome: 'failure', request, organizationId: org.id, userId: user?.id, metadata: { reason: 'invalid_credentials' } });
      return reply.code(401).send({ error: { code: 'INVALID_JOIN', message: 'Invalid company code, username, or password' } });
    }

    /**
     * THE SAME QUESTION /auth/login ASKS, asked here too.
     *
     * This door drifted from that one: login requires is_verified, join simply
     * omitted it. So an account created by invite acceptance — permanently
     * is_verified = false, because that flow never issued an OTP — could re-mint
     * a fresh seven-day session here, forever, having proven nothing.
     *
     * It sits AFTER the password check, not inside the classifier, for two
     * reasons. Only a caller who already holds the credentials learns the account
     * exists but is unproven; and the classifier's 'failure' branch increments
     * failed_login_count and eventually locks the account, which is the wrong
     * answer to someone typing the right password. That mirrors login's
     * 'non_counted_failure' branch, down to the status, the code and the message.
     *
     * ACCOUNTS CREATED BY AuthController.inviteUser ARE UNAFFECTED: that path
     * writes is_verified: true. This narrows exactly the accounts the invite
     * accept flow created, and only those of them minted after the cutover — see
     * VERIFICATION_ENFORCED_SINCE for why the older ones keep this door.
     */
    if (requiresEmailVerification(user)) {
      await auditLog({ action: 'auth.join', outcome: 'failure', request, organizationId: org.id, userId: user.id, metadata: { reason: 'email_not_verified' } });
      return reply.code(403).send({
        error: { code: 'ACCOUNT_NOT_VERIFIED', message: 'Please verify your account via the code sent to your phone and email.' },
      });
    }

    const token = await signSessionToken(request, reply, { ...user, role: user.role as AuthRole });

    await auditLog({ action: 'auth.join', outcome: 'success', request, organizationId: org.id, userId: user.id });

    return reply.send({ data: { user: publicUser(user), token }, meta: {} });
  },

  // Owner/admin view of the current rotating company code (regenerates lazily if expired).
  getCompanyCode: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    if (!can(callerRole, 'team.manage')) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: TEAM_DENIAL_MESSAGES.readCompanyCode } });
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
    if (!can(callerRole, 'team.manage')) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: TEAM_DENIAL_MESSAGES.rotateCompanyCode } });
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

    const callingUser = await db.user.findUnique({
      where: { id: request.user.sub },
      select: { must_change_email: true },
    });
    if (!callingUser?.must_change_email) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Credentials already set. Use the change-password flow instead.' } });
    }

    const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (existing && existing.id !== request.user.sub) {
      return reply.status(409).send({ error: { code: 'EMAIL_ALREADY_EXISTS', message: 'An account with this email already exists' } });
    }

    const newHash = await bcrypt.hash(new_password, saltRounds);
    // `email_verified: false`, because nothing here proved anything. This wrote
    // `true` for whatever address the caller typed — no OTP, no possession check
    // of any kind — which made the column actively false data rather than merely
    // unenforced. Nothing reads it today, so this changes no behaviour; it stops
    // the row from lying to whatever reads it next.
    //
    // `is_verified` is deliberately NOT touched. AuthController.inviteUser writes
    // it true when it creates these accounts, and these are the users who reach
    // this handler (must_change_email gates entry, three lines up). Clearing it
    // would lock them out of /auth/login and /auth/join on their first-run screen
    // — and no OTP could rescue them, because POST /auth/verify refuses any
    // account whose is_verified is already true.
    const user = await db.user.update({
      where: { id: request.user.sub },
      data: { email, password_hash: newHash, email_verified: false, must_change_password: false, must_change_email: false },
    });

    await revokeAllUserSessions(request.user.sub, request.user.org_id, 'credentials_changed');

    await auditLog({ action: 'auth.set_credentials', outcome: 'success', request, organizationId: request.user.org_id, userId: request.user.sub, metadata: { email } });

    return reply.send({ data: { user: publicUser(user) }, meta: {} });
  },

  setTimezone: async (request: FastifyRequest, reply: FastifyReply) => {
    const { timezone } = request.body as { timezone: string };
    const updated = await db.user.updateMany({
      where: {
        id: request.user.sub,
        organization_id: request.user.org_id,
        is_active: true,
      },
      data: { timezone },
    });

    if (updated.count !== 1) {
      return reply.status(404).send({
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }

    await auditLog({
      action: 'auth.update_timezone',
      outcome: 'success',
      request,
      organizationId: request.user.org_id,
      userId: request.user.sub,
      metadata: { timezone },
    });

    return reply.send({ data: { timezone }, meta: {} });
  },

  deactivateUser: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    if (!can(callerRole, 'team.manage')) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: TEAM_DENIAL_MESSAGES.deactivate } });
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
    // Was `target.role === 'owner'`, which let an ADMIN deactivate a peer admin —
    // an operation CAPABILITIES reserves to the owner, and one that locks the
    // target out of the entire product on their next request.
    const refusal = refuseAdminLevelTarget(callerRole, target.role);
    if (refusal) {
      await auditLog({
        action: 'team.deactivate_member',
        outcome: 'denied',
        request,
        organizationId: request.user.org_id,
        userId: request.user.sub,
        targetType: 'user',
        targetId: id,
        metadata: { reason: 'admin_level_target', target_role: target.role, role: callerRole },
      });
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: refusal } });
    }

    await db.user.update({ where: { id }, data: { is_active: false } });

    /**
     * DEACTIVATION HAS TO CLOSE EVERY DOOR, not just the login form.
     *
     * It closed none of them. The row went `is_active: false` and that was the
     * whole handler: live sessions were left to expire on their own (changeUserRole
     * below has always called revokeAllUserSessions; this one never did), and any
     * API key the person had minted kept working — services/public-api-auth.ts
     * validates the key row alone and never looks at the creator, so removing a
     * rogue admin left intact the one channel an admin is uniquely able to create.
     */
    await revokeAllUserSessions(id, request.user.org_id, 'deactivated');
    await db.apiKey.updateMany({
      where: { organization_id: request.user.org_id, created_by: id, revoked_at: null },
      data: { revoked_at: new Date() },
    });

    await auditLog({
      action: 'team.deactivate_member',
      outcome: 'success',
      request,
      organizationId: request.user.org_id,
      userId: request.user.sub,
      targetType: 'user',
      targetId: id,
      metadata: { target_role: target.role },
    });

    return reply.send({ data: { id }, meta: {} });
  },

  changeUserRole: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    // team.manage_admins, NOT team.manage. The literal it replaces was
    // owner-only, and team.manage_admins is the owner-only capability — using
    // team.manage here would silently hand re-roling to every admin, which is a
    // widening dressed up as a refactor.
    if (!can(callerRole, 'team.manage_admins')) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: TEAM_DENIAL_MESSAGES.changeRole } });
    }

    const { id } = request.params as { id: string };
    if (id === request.user.sub) {
      return reply.status(400).send({ error: { code: 'CANNOT_CHANGE_OWN_ROLE', message: 'You cannot change your own role' } });
    }

    const { role } = request.body as { role: AuthRole };
    const allowedRoles = assignableRoles(callerRole);
    if (!isRole(role) || !allowedRoles.includes(role)) {
      return reply.status(400).send({
        error: { code: 'INVALID_ROLE', message: `Role must be one of: ${allowedRoles.join(', ')}` },
      });
    }

    const target = await db.user.findFirst({
      where: { id, organization_id: request.user.org_id },
      select: { id: true },
    });
    if (!target) {
      return reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }

    const updated = await db.user.update({ where: { id }, data: { role }, select: { id: true, role: true } });
    await revokeAllUserSessions(id, request.user.org_id, 'role_changed');
    await auditLog({
      action: 'team.change_role',
      outcome: 'success',
      request,
      organizationId: request.user.org_id,
      userId: request.user.sub,
      targetType: 'user',
      targetId: id,
      metadata: { role },
    });
    return reply.send({ data: updated, meta: {} });
  },

  setUserManager: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role as AuthRole;
    if (!can(callerRole, 'team.manage')) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: TEAM_DENIAL_MESSAGES.setManager } });
    }

    const { id } = request.params as { id: string };
    const { manager_id } = request.body as { manager_id: string | null };

    // Target user must exist and belong to caller's org. `role` is selected
    // because this handler had NO target guard at all — not even the string
    // comparison deactivateUser had — so an admin could reparent the owner under
    // a `head`, and the recursive CTE in services/visibility.ts would then hand
    // that head the owner's contacts, deals and tasks. Reparenting is a
    // modification of an admin-level member; it belongs to the owner.
    const target = await db.user.findFirst({
      where: { id, organization_id: request.user.org_id },
      select: { id: true, role: true },
    });
    if (!target) {
      return reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }

    const refusal = refuseAdminLevelTarget(callerRole, target.role);
    if (refusal) {
      await auditLog({
        action: 'team.set_manager',
        outcome: 'denied',
        request,
        organizationId: request.user.org_id,
        userId: request.user.sub,
        targetType: 'user',
        targetId: id,
        metadata: { reason: 'admin_level_target', target_role: target.role, role: callerRole },
      });
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: refusal } });
    }

    if (manager_id !== null) {
      // Self-management check.
      if (manager_id === id) {
        return reply.status(400).send({ error: { code: 'CANNOT_MANAGE_SELF', message: 'A user cannot be their own manager' } });
      }

      // Prospective manager must exist in the same org.
      const managerUser = await db.user.findFirst({
        where: { id: manager_id, organization_id: request.user.org_id },
        select: { id: true, manager_id: true },
      });
      if (!managerUser) {
        return reply.status(404).send({ error: { code: 'MANAGER_NOT_FOUND', message: 'Manager user not found in this organisation' } });
      }

      // Cycle detection: one recursive CTE walks the entire manager chain in a single query.
      // If `id` appears anywhere in the chain rooted at `manager_id`, it's a cycle.
      const cycleRows = await db.$queryRaw<Array<{ id: string }>>`
        WITH RECURSIVE chain AS (
          SELECT id, manager_id FROM "User" WHERE id = ${manager_id}::uuid
          UNION ALL
          SELECT u.id, u.manager_id FROM "User" u INNER JOIN chain c ON u.id = c.manager_id
        )
        SELECT id FROM chain WHERE id = ${id}::uuid
        LIMIT 1
      `;
      if (cycleRows.length > 0) {
        return reply.status(400).send({ error: { code: 'MANAGER_CYCLE', message: 'Assigning this manager would create a reporting cycle' } });
      }
    }

    const updated = await db.user.update({
      where: { id },
      data: { manager_id },
    });

    await auditLog({
      action: 'team.set_manager',
      outcome: 'success',
      request,
      organizationId: request.user.org_id,
      userId: request.user.sub,
      targetType: 'user',
      targetId: id,
      metadata: { manager_id },
    });

    return reply.send({ data: publicUser(updated), meta: {} });
  },

  verifyOtp: async (request: FastifyRequest, reply: FastifyReply) => {
    const { user_id, code } = request.body as { user_id: string; code: string };
    const channel = 'email' as const;

    const user = await db.user.findUnique({
      where: { id: user_id },
      select: { id: true, email: true, name: true, role: true, organization_id: true, timezone: true, is_verified: true, is_active: true },
    });

    if (!user || !user.is_active) {
      return reply.code(400).send({ error: { code: 'INVALID_CODE', message: 'Code is invalid or has expired' } });
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

    await db.user.update({
      where: { id: user_id },
      data: { email_verified: true, is_verified: true },
    });

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
        user: { id: user.id, email: user.email, name: user.name, role: user.role, org_id: user.organization_id, timezone: user.timezone, onboarding_completed: false },
        token,
      },
      meta: {},
    });
  },

  changePassword: async (request: FastifyRequest, reply: FastifyReply) => {
    const { current_password, new_password } = request.body as { current_password: string; new_password: string };

    const user = await db.user.findFirst({
      where: { id: request.user.sub, organization_id: request.user.org_id },
      select: { password_hash: true },
    });
    const currentPasswordMatches = await bcrypt.compare(current_password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !currentPasswordMatches) {
      return reply.code(401).send({
        error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect' },
      });
    }

    const newHash = await bcrypt.hash(new_password, saltRounds);
    await db.user.update({
      where: { id: request.user.sub },
      data: { password_hash: newHash, must_change_password: false },
    });

    await revokeAllUserSessions(request.user.sub, request.user.org_id, 'password_changed');

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

  /**
   * POST /auth/verify/resend — ONE ANSWER, WHATEVER IS ON THE OTHER END.
   *
   * This route is public (isPublicApiRoute, authenticate.ts) and it must be: the
   * person who needs it has no session yet, and since requiresEmailVerification()
   * became a gate on every authenticated request it is the ONLY door back into
   * the product for a new invitee — there is no forgot-password flow and no SMS.
   *
   * It used to answer in four distinguishable ways — 404 USER_NOT_FOUND, 409
   * ALREADY_VERIFIED, 400 EMAIL_MISSING, 200 sent — which made it an
   * account-state oracle for anyone holding a user_id. Those are not secret:
   * register returns one, invite-accept returns one, and GET /auth/users lists
   * every colleague's to every org member. A departed employee who kept that list
   * could, from any machine and with no credentials, watch the org's headcount
   * and onboarding forever, and nothing was written anywhere the owner could see.
   *
   * Now: 202, one body, every path — including the paths that send nothing.
   *
   *   • 202 rather than 200 because it is the honest status. The old 200
   *     `{sent:true}` was returned even with RESEND_API_KEY unset, when nothing
   *     had been sent and nothing ever would be.
   *   • The send is NOT awaited. Awaiting a Resend round trip on the success path
   *     while the rejection paths return after one findUnique leaves a
   *     hundreds-of-milliseconds gap behind the identical body — the same timing
   *     oracle verifyPasswordWithLockout above runs a dummy bcrypt to close. Four
   *     branches that all return after one query cannot be told apart by a clock.
   *   • The truth goes to auditLog, which is org-scoped and owner-visible, rather
   *     than into the HTTP response. That is the whole trade: the owner keeps the
   *     diagnostic, the anonymous caller loses the oracle. `organization_id` is
   *     selected specifically so the row is not written org-NULL and invisible to
   *     GET /auth/audit — see services/audit.ts. A probe for a user that does not
   *     exist HAS no org and is unavoidably org-NULL; that is a known limit,
   *     recorded here rather than papered over.
   */
  resendVerification: async (request: FastifyRequest, reply: FastifyReply) => {
    const { user_id } = request.body as { user_id: string };

    // Computed once, sent on every path, including the failures.
    const answer = () => reply.code(202).send({ data: { sent: true }, meta: {} });

    const audit = (
      reason: string,
      organizationId: string | null,
    ) => auditLog({
      action: 'auth.verify_resend',
      outcome: reason === 'sent' ? 'success' : 'denied',
      request,
      organizationId,
      userId: user_id,
      metadata: { reason },
    });

    /**
     * SPENT BEFORE THE LOOKUP, UNCONDITIONALLY, so every request performs the
     * same work whatever the user_id resolves to — a budget spent only on the
     * hit path is a timing oracle wearing a security control's clothes.
     *
     * Keyed on the TARGET. Every other limiter on this route keys on
     * `request.ip` (authRateLimit's default and enforceAuthIpFloor both), and an
     * attacker with more than one address — an IPv6 /64, a mobile carrier, a
     * small botnet — has an unbounded budget against one victim under all of
     * them. This is the only control that sees that shape.
     *
     * 10/hour, not 5: the ceiling is shared fate with the victim, who has no
     * other way in, and register and invite-accept have already burned a code
     * before anyone reaches this button. VERIFY_RESEND_PER_USER_MAX exists
     * because a live box needs a knob when a limit misfires — same reason as
     * AUTH_IP_RATE_LIMIT_MAX.
     */
    const perUserMax = Number.parseInt(process.env.VERIFY_RESEND_PER_USER_MAX ?? '', 10);
    const budget = await consumeScopedBudget(
      'verify-resend-user',
      user_id,
      Number.isFinite(perUserMax) && perUserMax > 0 ? perUserMax : 10,
      60 * 60 * 1000,
    );

    const user = await db.user.findUnique({
      where: { id: user_id },
      select: { id: true, email: true, is_verified: true, is_active: true, organization_id: true },
    });

    if (!user || !user.is_active) {
      await audit('not_found', null);
      return answer();
    }

    if (user.is_verified) {
      await audit('already_verified', user.organization_id);
      return answer();
    }

    if (!user.email) {
      await audit('no_email', user.organization_id);
      return answer();
    }

    if (!budget.allowed) {
      // Deliberately NOT a 429. A refusal that only the real account can trigger
      // is the oracle again, from the other end. It also does not call issueCode,
      // which is what keeps the victim's outstanding code alive.
      await audit('per_user_budget', user.organization_id);
      return answer();
    }

    const address = user.email;
    void (async () => {
      try {
        const code = await issueCode(user_id, 'email');
        if (isEmailSendingEnabled()) {
          await sendEmail(address, 'Код подтверждения', `Ваш код: ${code}. Действителен 10 минут.`);
        }
      } catch {
        // Detached on purpose (see above); a delivery failure must not become an
        // unhandled rejection. The audit row below already records the attempt.
      }
    })();

    await audit('sent', user.organization_id);
    return answer();
  },

  /**
   * POST /auth/forgot-password — start a reset. ALWAYS the same answer.
   *
   * The product had no recovery at all: `PATCH /auth/me/password` and
   * `/auth/me/credentials` both sit behind jwtVerify, so they are useless to
   * someone locked out; `POST /auth/users/invite` CREATES an account rather than
   * resetting one; and `/auth/invites/accept` answers 409 EMAIL_TAKEN at the
   * victim's own address. The remedy was a hand-written UPDATE against the
   * production User table — routine psql against live customer data as the
   * standard support procedure, which is a bigger risk than the lockout.
   *
   * Reuses VerificationCode on a SEPARATE CHANNEL. No migration: `channel` is a
   * plain String and every query in services/verification.ts is scoped by it.
   * The channel must not be 'email': POST /auth/verify is public, takes a bare
   * user_id plus a six-digit code on that channel, and mints a seven-day session
   * — a reset code issued there would be a password-free login.
   *
   * ENUMERATION. One status, one body, no user_id, on every path — including an
   * address that does not exist. The send is NOT awaited, for the same reason as
   * resendVerification above and for the same reason login runs bcrypt against
   * DUMMY_HASH: a live Resend round trip on the hit path (bounded at
   * EMAIL_SEND_TIMEOUT_MS = 20s) against one indexed SELECT on the miss path is
   * a two-order-of-magnitude timing gap behind identical bytes, which is a
   * better oracle than the one this shape was chosen to avoid.
   */
  forgotPassword: async (request: FastifyRequest, reply: FastifyReply) => {
    const { email: rawEmail } = request.body as { email: string };
    const email = normalizeEmail(rawEmail);

    const answer = () => reply.code(202).send({ data: { sent: true }, meta: {} });

    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, is_active: true, organization_id: true },
    });

    if (!user || !user.is_active || !user.email) {
      await auditLog({
        action: 'auth.password_reset_request',
        outcome: 'denied',
        request,
        organizationId: user?.organization_id ?? null,
        userId: user?.id ?? null,
        metadata: { reason: user ? 'inactive_or_no_email' : 'no_such_account' },
      });
      return answer();
    }

    /**
     * A budget keyed on the ACCOUNT, not the address the caller came from.
     * Without it, anyone who knows a colleague's email can send unlimited reset
     * mail from rotating IPs — burning the shared Resend quota the OTP path also
     * depends on, and, because issuing a code retires the oldest outstanding
     * one, eventually starving the person actually trying to recover.
     */
    const budget = await consumeScopedBudget(
      'password-reset-user',
      user.id,
      5,
      60 * 60 * 1000,
    );

    if (!budget.allowed) {
      await auditLog({
        action: 'auth.password_reset_request',
        outcome: 'denied',
        request,
        organizationId: user.organization_id,
        userId: user.id,
        metadata: { reason: 'per_user_budget' },
      });
      return answer();
    }

    const address = user.email;
    const userId = user.id;
    const orgId = user.organization_id;
    void (async () => {
      try {
        const code = await issueCode(userId, 'password_reset');
        const result = isEmailSendingEnabled()
          ? await sendEmail(
            address,
            'Код для смены пароля',
            `Ваш код: ${code}. Действителен 10 минут.`,
          )
          : { success: false, errorCode: 'SERVICE_NOT_CONFIGURED' as const };

        // sendEmail RETURNS a failure, it does not throw. Recording the outcome
        // is the only way an operator can see that recovery is dead on a box
        // with no RESEND_API_KEY — the HTTP body cannot say so without becoming
        // the oracle again.
        if (!result.success) {
          await auditLog({
            action: 'auth.password_reset_request',
            outcome: 'failure',
            request,
            organizationId: orgId,
            userId,
            metadata: { reason: 'delivery_failed' },
          });
        }
      } catch {
        // Detached; must never surface as an unhandled rejection.
      }
    })();

    await auditLog({
      action: 'auth.password_reset_request',
      outcome: 'success',
      request,
      organizationId: user.organization_id,
      userId: user.id,
      metadata: { reason: 'sent' },
    });

    return answer();
  },

  /**
   * POST /auth/reset-password — finish a reset.
   *
   * One 400 for every failure mode, mirroring /auth/verify, so this half is not
   * an oracle either. On success the account is unlocked as well as re-credentialed:
   * a reset that leaves `locked_until` in the future has not recovered anybody.
   *
   * No session token is returned. A six-digit code should not be a login
   * primitive; the user signs in normally afterwards.
   */
  resetPassword: async (request: FastifyRequest, reply: FastifyReply) => {
    const { email: rawEmail, code, new_password } = request.body as {
      email: string;
      code: string;
      new_password: string;
    };
    const email = normalizeEmail(rawEmail);

    const refuse = async (reason: string, user: { id: string; organization_id: string } | null) => {
      await auditLog({
        action: 'auth.password_reset',
        outcome: 'failure',
        request,
        organizationId: user?.organization_id ?? null,
        userId: user?.id ?? null,
        metadata: { reason },
      });
      return reply.code(400).send({
        error: { code: 'INVALID_CODE', message: 'Code is invalid or has expired' },
      });
    };

    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, is_active: true, organization_id: true, is_verified: true },
    });

    if (!user || !user.is_active) {
      return refuse('no_such_account', null);
    }

    const valid = await verifyCode(user.id, code, 'password_reset');
    if (!valid) {
      return refuse('invalid_or_expired_code', user);
    }

    const newHash = await bcrypt.hash(new_password, saltRounds);
    await db.user.update({
      where: { id: user.id },
      data: {
        password_hash: newHash,
        must_change_password: false,
        // Clearing the lockout is the point. Recovery that leaves the counter at
        // 11 and locked_until half an hour out has changed the password and
        // recovered nothing.
        failed_login_count: 0,
        locked_until: null,
        /**
         * A code delivered to the address on file is the SAME proof
         * POST /auth/verify accepts before it sets is_verified. Setting it here
         * is therefore consistent rather than generous — and without it a
         * post-cutover unverified account completes a perfect reset and is still
         * refused by /auth/login with 403 ACCOUNT_NOT_VERIFIED, in a body that
         * carries no user_id, leaving POST /auth/verify/resend uninvokable and
         * the person exactly as stuck as before.
         */
        is_verified: true,
        email_verified: true,
      },
    });

    await revokeAllUserSessions(user.id, user.organization_id, 'credentials_changed');

    await auditLog({
      action: 'auth.password_reset',
      outcome: 'success',
      request,
      organizationId: user.organization_id,
      userId: user.id,
      metadata: { was_unverified: !user.is_verified },
    });

    return reply.code(200).send({ data: { reset: true }, meta: {} });
  },
};
