import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { db } from '../../services/db';

const saltRounds = process.env.NODE_ENV === 'test' ? 4 : 12;

type AuthUserListItem = {
  id: string;
  email: string;
  name: string;
  role: string;
};

type AuthUsersResponse = {
  data: AuthUserListItem[];
  meta: {
    total: number;
  };
};

function onboardingCompleted(state: Prisma.JsonValue | null): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    !Array.isArray(state) &&
    (state as Record<string, unknown>).completed === true
  );
}

function publicUser(user: { id: string; email: string; name: string; role: string; organization_id: string; onboarding_state?: Prisma.JsonValue | null }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    org_id: user.organization_id,
    onboarding_completed: onboardingCompleted(user.onboarding_state ?? null),
  };
}

function generateSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

function invalidCredentials(reply: FastifyReply) {
  return reply.code(401).send({
    error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
  });
}

export const AuthController = {
  register: async (request: FastifyRequest, reply: FastifyReply) => {
    const { email, password, name, org_name } = request.body as {
      email: string;
      password: string;
      name: string;
      org_name: string;
    };

    try {
      const [password_hash, slug] = await Promise.all([
        bcrypt.hash(password, saltRounds),
        Promise.resolve(generateSlug(org_name)),
      ]);

      // Single SQL CTE: org + user + owner_id update + pipeline + stages in one round-trip.
      // The circular FK (org.owner_id → user, user.organization_id → org) is broken by
      // inserting org with owner_id=NULL first, then updating once we have the user id.
      const rows = await db.$queryRaw<Array<{ org_id: string; user_id: string }>>`
        WITH
          org_cte AS (
            INSERT INTO organizations (name, slug, plan, updated_at)
            VALUES (${org_name}, ${slug}, 'starter'::"OrgPlan", NOW())
            RETURNING id
          ),
          user_cte AS (
            INSERT INTO "User" (organization_id, email, password_hash, name, role, updated_at)
            SELECT id, ${email}, ${password_hash}, ${name}, 'owner'::"UserRole", NOW()
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

      const token = await reply.jwtSign(
        { sub: user_id, org_id, role: 'owner' },
        { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' }
      );

      return reply.code(201).send({
        data: {
          user: { id: user_id, email, name, role: 'owner', org_id, onboarding_completed: false },
          token,
        },
        meta: {},
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
        return reply.code(409).send({
          error: { code: 'EMAIL_ALREADY_EXISTS', message: 'An account with this email already exists' },
        });
      }
      throw err;
    }
  },

  login: async (request: FastifyRequest, reply: FastifyReply) => {
    const { email, password } = request.body as { email: string; password: string };

    const user = await db.user.findUnique({ where: { email } });

    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      return invalidCredentials(reply);
    }

    const token = await reply.jwtSign(
      { sub: user.id, org_id: user.organization_id, role: user.role },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' }
    );

    return reply.send({
      data: {
        user: publicUser(user),
        token,
      },
      meta: {},
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
};
