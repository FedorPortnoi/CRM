import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { db } from '../../services/db';

function generateSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
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
      const password_hash = await bcrypt.hash(password, 12);

      const { org, user } = await db.$transaction(async (tx) => {
        const slug = generateSlug(org_name);

        const org = await tx.org.create({
          data: { name: org_name, slug, plan: 'starter' },
        });

        const user = await tx.user.create({
          data: {
            email,
            password_hash,
            name,
            organization_id: org.id,
            role: 'owner',
          },
        });

        await tx.org.update({
          where: { id: org.id },
          data: { owner_id: user.id },
        });

        // Seed default Sales Pipeline with 4 stages
        const pipeline = await tx.pipeline.create({
          data: {
            name: 'Sales Pipeline',
            is_default: true,
            organization_id: org.id,
            created_by: user.id,
          },
        });

        await tx.pipelineStage.createMany({
          data: [
            { pipeline_id: pipeline.id, name: 'Lead',       position: 0 },
            { pipeline_id: pipeline.id, name: 'Qualified',  position: 1 },
            { pipeline_id: pipeline.id, name: 'Proposal',   position: 2 },
            { pipeline_id: pipeline.id, name: 'Closed Won', position: 3, is_won_stage: true },
          ],
        });

        return { org, user };
      });

      const token = await reply.jwtSign(
        { sub: user.id, org_id: org.id, role: user.role },
        { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' }
      );

      return reply.code(201).send({
        data: {
          user: { id: user.id, email: user.email, name: user.name, role: user.role, org_id: org.id },
          token,
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
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

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return reply.code(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    const token = await reply.jwtSign(
      { sub: user.id, org_id: user.organization_id, role: user.role },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' }
    );

    return reply.send({
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role, org_id: user.organization_id },
        token,
      },
    });
  },
};
