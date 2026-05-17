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

type UpdateBody = {
  completed_steps?: string[];
  dismissed_tooltips?: string[];
  completed_at?: string | null;
};

function toJson(value: OnboardingState): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function mergeState(current: OnboardingState, update: UpdateBody): OnboardingState {
  return {
    completed_steps: update.completed_steps ?? current.completed_steps,
    dismissed_tooltips: update.dismissed_tooltips ?? current.dismissed_tooltips,
    example_data_loaded: current.example_data_loaded,
    completed_at: update.completed_at !== undefined ? update.completed_at : current.completed_at,
  };
}

async function getState(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: request.user.sub },
    select: { onboarding_state: true },
  });
  const state = (user?.onboarding_state as OnboardingState | null) ?? DEFAULT_STATE;
  await reply.status(200).send({ data: state, meta: {} });
}

async function updateState(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body as UpdateBody;
  const user = await db.user.findUnique({
    where: { id: request.user.sub },
    select: { onboarding_state: true },
  });
  const current = (user?.onboarding_state as OnboardingState | null) ?? DEFAULT_STATE;
  const merged = mergeState(current, body);
  await db.user.update({
    where: { id: request.user.sub },
    data: { onboarding_state: toJson(merged) },
  });
  await reply.status(200).send({ data: merged, meta: {} });
}

async function loadExampleData(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const orgId = request.user.org_id;
  const userId = request.user.sub;

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

  const contacts = await Promise.all(
    contactData.map((c) =>
      db.contact.create({
        data: {
          ...c,
          organization_id: orgId,
          created_by: userId,
          is_example_data: true,
          notes: '[example] Тестовый контакт для демонстрации.',
        },
      }),
    ),
  );

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);

  await Promise.all([
    db.deal.create({
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
    db.deal.create({
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
    db.task.create({
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
    db.task.create({
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
    db.task.create({
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

  const user = await db.user.findUnique({ where: { id: userId }, select: { onboarding_state: true } });
  const current = (user?.onboarding_state as OnboardingState | null) ?? DEFAULT_STATE;
  await db.user.update({
    where: { id: userId },
    data: { onboarding_state: toJson({ ...current, example_data_loaded: true }) },
  });

  await reply.status(201).send({ data: { contacts: 5, deals: 2, tasks: 3 }, meta: {} });
}

async function clearExampleData(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const orgId = request.user.org_id;
  const userId = request.user.sub;

  await db.task.deleteMany({ where: { organization_id: orgId, is_example_data: true } });
  await db.deal.deleteMany({ where: { organization_id: orgId, is_example_data: true } });
  await db.contact.deleteMany({ where: { organization_id: orgId, is_example_data: true } });

  const user = await db.user.findUnique({ where: { id: userId }, select: { onboarding_state: true } });
  const current = (user?.onboarding_state as OnboardingState | null) ?? DEFAULT_STATE;
  await db.user.update({
    where: { id: userId },
    data: { onboarding_state: toJson({ ...current, example_data_loaded: false }) },
  });

  await reply.status(200).send({ data: { cleared: true }, meta: {} });
}

export const OnboardingController = { getState, updateState, loadExampleData, clearExampleData };
