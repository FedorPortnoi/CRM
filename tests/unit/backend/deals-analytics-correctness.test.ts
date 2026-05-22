import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DealStatus } from '@prisma/client';

const dbMock = vi.hoisted(() => ({
  deal: {
    count: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  pipelineStage: {
    deleteMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({
  db: dbMock,
}));

vi.mock('../../../backend/services/workflows', () => ({
  evaluateWorkflows: vi.fn(),
}));

import { AnalyticsController } from '../../../backend/api/controllers/analytics';
import { DealsController } from '../../../backend/api/controllers/deals';

const orgId = '00000000-0000-4000-a000-000000000123';
const userId = '00000000-0000-4000-a000-000000000456';

type TestReply = {
  statusCode: number;
  payload: unknown;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function createReply(): TestReply {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status: vi.fn(function setStatus(this: TestReply, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }),
    send: vi.fn(function send(this: TestReply, payload: unknown) {
      this.payload = payload;
      return this;
    }),
  };

  return reply as unknown as TestReply;
}

describe('analytics and deals audited correctness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters revenue by requested currency and includes the full custom end day', async () => {
    dbMock.deal.findMany.mockResolvedValue([
      {
        actual_close: new Date('2026-05-31T18:30:00.000Z'),
        value: 120,
      },
    ]);
    const reply = createReply();

    await AnalyticsController.revenue(
      {
        query: {
          period: 'custom',
          start: '2026-05-01',
          end: '2026-05-31',
          group_by: 'month',
          currency: 'EUR',
        },
        user: { org_id: orgId, sub: userId },
      } as never,
      reply as never,
    );

    const findManyArgs = dbMock.deal.findMany.mock.calls[0][0];
    expect(findManyArgs.where.currency).toBe('EUR');
    expect(findManyArgs.where.actual_close.gte.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(findManyArgs.where.actual_close.lte.toISOString()).toBe('2026-05-31T23:59:59.999Z');
    expect(reply.payload).toMatchObject({
      data: {
        period: { currency: 'EUR' },
        summary: { total_revenue: 120 },
      },
      meta: {},
    });
  });

  it('uses stage_entered_at rather than updated_at for stage duration averages', async () => {
    dbMock.deal.findMany.mockResolvedValue([
      {
        stage_id: '00000000-0000-4000-a000-000000000111',
        status: DealStatus.won,
        stage_entered_at: new Date('2026-05-01T00:00:00.000Z'),
        updated_at: new Date('2026-05-10T00:00:00.000Z'),
        actual_close: new Date('2026-05-03T00:00:00.000Z'),
        pipeline_id: '00000000-0000-4000-a000-000000000222',
        stage: { name: 'Qualified', position: 1 },
        pipeline: { name: 'Sales' },
      },
    ]);
    const reply = createReply();

    await AnalyticsController.stageDuration(
      {
        query: { period: 'month' },
        user: { org_id: orgId, sub: userId },
      } as never,
      reply as never,
    );

    const findManyArgs = dbMock.deal.findMany.mock.calls[0][0];
    expect(findManyArgs.select.stage_entered_at).toBe(true);
    expect(findManyArgs.select.updated_at).toBeUndefined();
    expect(reply.payload).toMatchObject({
      data: [{ stage_name: 'Qualified', avg_days: 2, deal_count: 1 }],
    });
  });

  it('clears non-open deal stage references before deleting an unused stage', async () => {
    const stageId = '00000000-0000-4000-a000-000000000111';
    const pipelineId = '00000000-0000-4000-a000-000000000222';
    dbMock.pipelineStage.findFirst.mockResolvedValue({ id: stageId, pipeline_id: pipelineId });
    dbMock.deal.count.mockResolvedValue(0);
    dbMock.deal.updateMany.mockResolvedValue({ count: 2 });
    dbMock.pipelineStage.deleteMany.mockResolvedValue({ count: 1 });
    const reply = createReply();

    await DealsController.deleteStage(
      {
        params: { id: stageId },
        user: { org_id: orgId, sub: userId },
      } as never,
      reply as never,
    );

    expect(dbMock.deal.updateMany).toHaveBeenCalledWith({
      where: { stage_id: stageId, organization_id: orgId, status: { not: DealStatus.open } },
      data: { stage_id: null },
    });
    expect(dbMock.pipelineStage.deleteMany).toHaveBeenCalledWith({
      where: { id: stageId, pipeline: { organization_id: orgId } },
    });
    expect(dbMock.deal.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.pipelineStage.deleteMany.mock.invocationCallOrder[0],
    );
    expect(reply.payload).toEqual({ data: { deleted: true }, meta: {} });
  });
});
