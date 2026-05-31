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

async function loadExampleData(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const orgId = request.user.org_id;
  const userId = request.user.sub;

  const current = await readUserState(userId, orgId);
  const existingExampleCounts = await Promise.all([
    db.contact.count({ where: { organization_id: orgId, is_example_data: true } }),
    db.deal.count({ where: { organization_id: orgId, is_example_data: true } }),
    db.task.count({ where: { organization_id: orgId, is_example_data: true } }),
  ]);

  if (current.example_data_loaded || existingExampleCounts.some((count) => count > 0)) {
    const updated = current.example_data_loaded
      ? true
      : await updateUserState(userId, orgId, { ...current, example_data_loaded: true });

    if (!updated) {
      await reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
      return;
    }

    await reply.status(201).send({
      data: {
        contacts: existingExampleCounts[0],
        deals: existingExampleCounts[1],
        tasks: existingExampleCounts[2],
      },
      meta: { already_loaded: true },
    });
    return;
  }

  const stage = await db.pipelineStage.findFirst({
    where: { pipeline: { organization_id: orgId } },
    orderBy: { position: 'asc' },
  });

  const contactData = [
    { first_name: 'Алексей', last_name: 'Смирнов', email: 'a.smirnov@romaschka.ru', phone: '+79161234567', company: 'ООО Ромашка' },
    { first_name: 'Мария', last_name: 'Петрова', email: 'm.petrova@ip-ivanov.ru', phone: '+79262345678', company: 'ИП Иванов' },
    { first_name: 'Дмитрий', last_name: 'Козлов', email: 'd.kozlov@alfagroup.ru', phone: '+79363456789', company: 'Альфа Групп' },
    { first_name: 'Елена', last_name: 'Новикова', email: 'e.novikova@betatech.ru', phone: '+79464567890', company: 'БетаТех' },
    { first_name: 'Сергей', last_name: 'Морозов', email: 's.morozov@gamma-service.ru', phone: '+79565678901', company: 'Гамма-Сервис' },
  ];

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);

  const loaded = await db.$transaction(async (tx) => {
    const contacts: Array<{ id: string }> = [];
    for (const contact of contactData) {
      contacts.push(await tx.contact.create({
        data: {
          ...contact,
          organization_id: orgId,
          created_by: userId,
          is_example_data: true,
          notes: '[example] Тестовый контакт для демонстрации.',
        },
      }));
    }

    await Promise.all([
      tx.deal.create({
        data: {
          title: 'Пример сделки — Новый клиент',
          organization_id: orgId,
          created_by: userId,
          contact_id: contacts[0].id,
          pipeline_id: stage?.pipeline_id ?? undefined,
          stage_id: stage?.id ?? undefined,
          status: 'open',
          is_example_data: true,
        },
      }),
      tx.deal.create({
        data: {
          title: 'Пример сделки — Закрытая',
          organization_id: orgId,
          created_by: userId,
          contact_id: contacts[1].id,
          pipeline_id: stage?.pipeline_id ?? undefined,
          stage_id: stage?.id ?? undefined,
          status: 'won',
          is_example_data: true,
        },
      }),
      tx.task.create({
        data: {
          title: 'Позвонить Алексею Смирнову',
          organization_id: orgId,
          created_by: userId,
          assigned_to: userId,
          contact_id: contacts[0].id,
          due_date: dueDate,
          status: 'pending',
          priority: 'medium',
          is_example_data: true,
        },
      }),
      tx.task.create({
        data: {
          title: 'Отправить коммерческое предложение',
          organization_id: orgId,
          created_by: userId,
          assigned_to: userId,
          contact_id: contacts[1].id,
          due_date: dueDate,
          status: 'pending',
          priority: 'high',
          is_example_data: true,
        },
      }),
      tx.task.create({
        data: {
          title: 'Согласовать условия договора',
          organization_id: orgId,
          created_by: userId,
          assigned_to: userId,
          contact_id: contacts[2].id,
          due_date: dueDate,
          status: 'pending',
          priority: 'low',
          is_example_data: true,
        },
      }),
    ]);

    const userUpdate = await tx.user.updateMany({
      where: { id: userId, organization_id: orgId },
      data: { onboarding_state: toJson({ ...current, example_data_loaded: true }) },
    });

    return userUpdate.count === 1;
  });

  if (!loaded) {
    await reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    return;
  }

  await reply.status(201).send({ data: { contacts: 5, deals: 2, tasks: 3 }, meta: {} });
}

async function clearExampleData(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const orgId = request.user.org_id;
  const userId = request.user.sub;

  await db.task.deleteMany({ where: { organization_id: orgId, is_example_data: true } });
  await db.deal.deleteMany({ where: { organization_id: orgId, is_example_data: true } });
  await db.contact.deleteMany({ where: { organization_id: orgId, is_example_data: true } });

  const current = await readUserState(userId, orgId);
  const updated = await updateUserState(userId, orgId, { ...current, example_data_loaded: false });
  if (!updated) {
    await reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    return;
  }

  await reply.status(200).send({ data: { cleared: true }, meta: {} });
}

export const OnboardingController = { getState, updateState, loadExampleData, clearExampleData };
