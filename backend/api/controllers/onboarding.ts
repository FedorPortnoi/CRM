import { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '../../services/db';

interface OnboardingState {
  completed_steps: string[];
  dismissed_tooltips: string[];
  example_data_loaded: boolean;
  completed_at: string | null;
}

const DEFAULT_STATE: OnboardingState = {
  completed_steps: [],
  dismissed_tooltips: [],
  example_data_loaded: false,
  completed_at: null,
};

const WALKTHROUGH_STEPS = ['contacts', 'deals', 'tasks', 'calendar'];

type UpdateBody = {
  completed_steps?: string[];
  dismissed_tooltips?: string[];
  completed_at?: string | null;
};

function toJson(value: OnboardingState): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function normalizeState(value: Prisma.JsonValue | null): OnboardingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_STATE };
  }

  const record = value as Record<string, unknown>;
  const completedSteps = Array.isArray(record.completed_steps)
    ? record.completed_steps.filter((step): step is string => typeof step === 'string')
    : record.completed === true
      ? WALKTHROUGH_STEPS
      : [];
  const dismissedTooltips = Array.isArray(record.dismissed_tooltips)
    ? record.dismissed_tooltips.filter((step): step is string => typeof step === 'string')
    : Array.isArray(record.dismissed_steps)
      ? record.dismissed_steps.filter((step): step is string => typeof step === 'string')
      : [];

  return {
    completed_steps: completedSteps,
    dismissed_tooltips: dismissedTooltips,
    example_data_loaded: record.example_data_loaded === true,
    completed_at: typeof record.completed_at === 'string' ? record.completed_at : null,
  };
}

function mergeState(current: OnboardingState, update: UpdateBody): OnboardingState {
  return {
    completed_steps: update.completed_steps ?? current.completed_steps,
    dismissed_tooltips: update.dismissed_tooltips ?? current.dismissed_tooltips,
    example_data_loaded: current.example_data_loaded,
    completed_at: update.completed_at !== undefined ? update.completed_at : current.completed_at,
  };
}

async function readUserState(userId: string, orgId: string): Promise<OnboardingState> {
  const user = await db.user.findFirst({
    where: { id: userId, organization_id: orgId },
    select: { onboarding_state: true },
  });
  return normalizeState(user?.onboarding_state ?? null);
}

async function updateUserState(userId: string, orgId: string, state: OnboardingState): Promise<boolean> {
  const result = await db.user.updateMany({
    where: { id: userId, organization_id: orgId },
    data: { onboarding_state: toJson(state) },
  });
  return result.count === 1;
}

async function getState(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const state = await readUserState(request.user.sub, request.user.org_id);
  await reply.status(200).send({ data: state, meta: {} });
}

async function updateState(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body as UpdateBody;
  const current = await readUserState(request.user.sub, request.user.org_id);
  const merged = mergeState(current, body);
  const updated = await updateUserState(request.user.sub, request.user.org_id, merged);
  if (!updated) {
    await reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    return;
  }
  await reply.status(200).send({ data: merged, meta: {} });
}

export const OnboardingController = { getState, updateState };
