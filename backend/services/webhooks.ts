/**
 * Outbound webhooks.
 *
 * Endpoints are configured per organization (owner/admin only) and every delivery is
 * signed with an HMAC-SHA256 over `${timestamp}.${body}` so receivers can verify it.
 * Enqueue is fire-and-forget: a webhook failure must never block or fail the CRM request
 * that produced the event. Retries are driven by backend/services/scheduler.ts, which calls
 * runWebhookDeliveryTick() on its existing 60 s loop.
 */

import crypto from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Prisma, WebhookDeliveryStatus, WebhookStatus, WorkflowTrigger } from '@prisma/client';
import { db } from './db';
import { decryptField, encryptField } from './encryption';
import {
  assertSafeWebhookUrl,
  resolveSafeWebhookUrl,
  type SafeWebhookTarget,
  type WebhookDnsResolver,
} from './webhook-ssrf';

// ─── Constants ────────────────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
  'contact.created',
  'contact.updated',
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'task.created',
  'task.completed',
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const WEBHOOK_SECRET_ENTROPY_BYTES = 32;
export const MAX_WEBHOOK_ENDPOINTS_PER_ORG = 10;
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** Delay before attempt N+1, indexed by the number of attempts that have already failed. */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;
export const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

export const WEBHOOK_SIGNATURE_HEADER = 'x-crm-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-crm-timestamp';
export const WEBHOOK_EVENT_HEADER = 'x-crm-event';
export const WEBHOOK_DELIVERY_HEADER = 'x-crm-delivery';
export const WEBHOOK_USER_AGENT = '4KUB-CRM-Webhooks/1.0';

// A claimed delivery gets its next_attempt_at pushed this far out; the claim is the
// atomic compare-and-set, and a worker that dies mid-send releases the row after the lease.
// Exported so a test can assert the lease is measured from the claim rather than from the
// instant the tick started — see processWebhookDelivery().
export const WEBHOOK_LEASE_MS = 5 * 60_000;
const WEBHOOK_TICK_BATCH_SIZE = 100;
const WEBHOOK_TICK_SCAN_SIZE = 1000;
const WEBHOOK_SEND_CONCURRENCY = 5;
const WEBHOOK_ERROR_MAX_LENGTH = 500;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class WebhookEndpointNotFoundError extends Error {
  readonly code = 'WEBHOOK_ENDPOINT_NOT_FOUND';

  constructor() {
    super('Webhook endpoint not found');
    this.name = 'WebhookEndpointNotFoundError';
  }
}

export class WebhookEndpointLimitError extends Error {
  readonly code = 'WEBHOOK_ENDPOINT_LIMIT_REACHED';

  constructor() {
    super(`An organization can configure at most ${MAX_WEBHOOK_ENDPOINTS_PER_ORG} webhook endpoints`);
    this.name = 'WebhookEndpointLimitError';
  }
}

// ─── Secrets and signing ──────────────────────────────────────────────────────

export function generateWebhookSecret(
  randomSource: (size: number) => Buffer = crypto.randomBytes,
): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomSource(WEBHOOK_SECRET_ENTROPY_BYTES).toString('base64url')}`;
}

/** HMAC-SHA256 over `${timestamp}.${rawBody}`; the timestamp travels in its own header. */
export function signWebhookPayload(secret: string, timestamp: number, rawBody: string): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: number,
  rawBody: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signWebhookPayload(secret, timestamp, rawBody), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

// ─── Retry policy ─────────────────────────────────────────────────────────────

/** failedAttempts is 1 after the first attempt failed; null once the cap is reached. */
export function getWebhookRetryDelayMs(failedAttempts: number): number | null {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    return null;
  }
  return WEBHOOK_RETRY_DELAYS_MS[failedAttempts - 1] ?? null;
}

export function nextWebhookAttemptAt(failedAttempts: number, failedAt: Date): Date | null {
  const delay = getWebhookRetryDelayMs(failedAttempts);
  return delay === null ? null : new Date(failedAt.getTime() + delay);
}

export function getWebhookFailurePauseThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.WEBHOOK_FAILURE_PAUSE_THRESHOLD ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
}

/** Only 2xx counts as delivered. Redirects are never followed, so 3xx is a failure. */
export function isSuccessfulWebhookStatus(statusCode: number | null): boolean {
  return statusCode !== null && statusCode >= 200 && statusCode < 300;
}

// ─── Event payloads ───────────────────────────────────────────────────────────

type WebhookEntityType = 'contact' | 'deal' | 'task';

// Allowlisted per-entity fields. Nested relations loaded for the API response
// (contact/pipeline/stage objects, counts) are deliberately not forwarded.
const PAYLOAD_FIELDS: Readonly<Record<WebhookEntityType, readonly string[]>> = {
  contact: [
    'first_name', 'last_name', 'company', 'email', 'phone', 'mobile', 'type', 'status',
    'source', 'tags', 'assigned_to', 'created_by', 'created_at', 'updated_at',
  ],
  deal: [
    'title', 'value', 'currency', 'status', 'pipeline_id', 'stage_id', 'contact_id',
    'assigned_to', 'created_by', 'expected_close', 'actual_close', 'lost_reason',
    'stage_entered_at', 'created_at', 'updated_at',
  ],
  task: [
    'title', 'description', 'status', 'priority', 'due_date', 'contact_id', 'deal_id',
    'assigned_to', 'created_by', 'completed_at', 'created_at', 'updated_at',
  ],
};

const ENCRYPTED_CONTACT_FIELDS = new Set(['email', 'phone', 'mobile']);

function entityTypeForEvent(event: WebhookEventName): WebhookEntityType {
  return event.slice(0, event.indexOf('.')) as WebhookEntityType;
}

export function eventsFromJson(value: unknown): WebhookEventName[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowed = new Set<string>(WEBHOOK_EVENTS);
  return value.filter(
    (event): event is WebhookEventName => typeof event === 'string' && allowed.has(event),
  );
}

function normalizeEvents(events: readonly WebhookEventName[]): WebhookEventName[] {
  return WEBHOOK_EVENTS.filter((event) => events.includes(event));
}

export type WebhookDomainEvent = {
  organizationId: string;
  event: WebhookEventName;
  entityId: string;
  actorUserId?: string | null;
  record?: Record<string, unknown> | null;
};

export function buildWebhookPayload(event: WebhookDomainEvent): Prisma.InputJsonValue {
  const entityType = entityTypeForEvent(event.event);
  const record = event.record ?? {};
  const data: Record<string, unknown> = { id: event.entityId };

  for (const field of PAYLOAD_FIELDS[entityType]) {
    if (!(field in record)) continue;
    const value = record[field];
    data[field] = entityType === 'contact'
      && ENCRYPTED_CONTACT_FIELDS.has(field)
      && typeof value === 'string'
      ? decryptField(value)
      : value;
  }

  const envelope = {
    event: event.event,
    created_at: new Date().toISOString(),
    organization_id: event.organizationId,
    actor_user_id: event.actorUserId ?? null,
    data,
  };

  // Normalize Date/Decimal instances into JSON scalars so the value is storable as Json
  // and re-serializes identically on every retry.
  return JSON.parse(JSON.stringify(envelope)) as Prisma.InputJsonValue;
}

// ─── Emitting ─────────────────────────────────────────────────────────────────

export async function enqueueWebhookEvent(event: WebhookDomainEvent): Promise<void> {
  const endpoints = await db.webhookEndpoint.findMany({
    where: { organization_id: event.organizationId, status: WebhookStatus.active },
    select: { id: true, events: true },
  });

  const subscribed = endpoints.filter((endpoint) => eventsFromJson(endpoint.events).includes(event.event));
  if (subscribed.length === 0) {
    return;
  }

  const payload = buildWebhookPayload(event);
  const now = new Date();

  await db.webhookDelivery.createMany({
    data: subscribed.map((endpoint) => ({
      organization_id: event.organizationId,
      endpoint_id: endpoint.id,
      event_type: event.event,
      payload,
      status: WebhookDeliveryStatus.pending,
      next_attempt_at: now,
    })),
  });
}

/** Queue delivery without extending the latency of — or being able to fail — the originating request. */
export function fireWebhookEvent(event: WebhookDomainEvent): void {
  void enqueueWebhookEvent(event).catch((error) => {
    // Never log the payload, endpoint URL or signing secret.
    console.error(`[webhooks] failed to enqueue ${event.event}`, error);
  });
}

const WORKFLOW_TRIGGER_EVENTS: Readonly<Partial<Record<WorkflowTrigger, WebhookEventName>>> = {
  [WorkflowTrigger.contact_created]: 'contact.created',
  [WorkflowTrigger.deal_created]: 'deal.created',
  [WorkflowTrigger.deal_stage_changed]: 'deal.stage_changed',
  [WorkflowTrigger.deal_won]: 'deal.won',
  [WorkflowTrigger.task_created]: 'task.created',
  [WorkflowTrigger.task_completed]: 'task.completed',
};

/**
 * Outbound webhooks reuse the exact domain-event seam workflows already sit on, so
 * emit calls do not get scattered through controllers. `deal_stale` has no webhook
 * counterpart and is ignored; `contact.updated` and `deal.lost` have no WorkflowTrigger
 * and are fired directly from their domain write sites.
 */
export function fireWebhookEventForWorkflowTrigger(context: {
  organizationId: string;
  trigger: WorkflowTrigger;
  record: Record<string, unknown>;
  userId?: string | null;
}): void {
  const event = WORKFLOW_TRIGGER_EVENTS[context.trigger];
  if (!event) return;

  const entityId = typeof context.record.id === 'string' ? context.record.id : null;
  if (!entityId) return;

  fireWebhookEvent({
    organizationId: context.organizationId,
    event,
    entityId,
    actorUserId: context.userId ?? null,
    record: context.record,
  });
}

// ─── Sending ──────────────────────────────────────────────────────────────────

export type WebhookSendResult = {
  success: boolean;
  statusCode: number | null;
  error: string | null;
};

export type WebhookSendMeta = {
  event: string;
  deliveryId: string;
};

function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, _options: unknown, callback: (
    error: NodeJS.ErrnoException | null,
    address: string,
    family: number,
  ) => void) => {
    callback(null, address, family);
  }) as unknown as LookupFunction;
}

/**
 * POST a signed body to an already-validated target. Redirects are never followed —
 * node's http(s) client does not follow them and any 3xx is reported as a failure.
 */
export async function postSignedWebhook(
  target: SafeWebhookTarget,
  secret: string,
  rawBody: string,
  meta: WebhookSendMeta,
  timeoutMs: number = WEBHOOK_TIMEOUT_MS,
): Promise<WebhookSendResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const transport = target.url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<WebhookSendResult>((resolve) => {
    let settled = false;
    const finish = (result: WebhookSendResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const outbound = transport(target.url.toString(), {
      method: 'POST',
      agent: false,
      lookup: pinnedLookup(target.address, target.family),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        'User-Agent': WEBHOOK_USER_AGENT,
        [WEBHOOK_EVENT_HEADER]: meta.event,
        [WEBHOOK_DELIVERY_HEADER]: meta.deliveryId,
        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(secret, timestamp, rawBody),
      },
    }, (response) => {
      // The receiver's body is irrelevant — drain and discard it.
      response.resume();
      response.once('end', () => {
        const statusCode = response.statusCode ?? null;
        const success = isSuccessfulWebhookStatus(statusCode);
        finish({
          success,
          statusCode,
          error: success
            ? null
            : statusCode !== null && statusCode >= 300 && statusCode < 400
              ? `Webhook receiver returned HTTP ${statusCode}; redirects are not followed`
              : `Webhook receiver returned HTTP ${statusCode ?? 'unknown'}`,
        });
      });
      response.once('error', (error: Error) => {
        finish({ success: false, statusCode: response.statusCode ?? null, error: error.message });
      });
      response.once('close', () => {
        finish({
          success: false,
          statusCode: response.statusCode ?? null,
          error: 'Webhook response was truncated',
        });
      });
    });

    const deadline = setTimeout(() => {
      outbound.destroy(new Error('Webhook request timed out'));
    }, timeoutMs);

    outbound.once('error', (error: Error) => {
      finish({ success: false, statusCode: null, error: error.message });
    });
    outbound.end(rawBody);
  });
}

/** Re-validate the URL immediately before connecting, then send with the address pinned. */
export async function sendSignedWebhook(
  rawUrl: string,
  secret: string,
  rawBody: string,
  meta: WebhookSendMeta,
  resolver?: WebhookDnsResolver,
): Promise<WebhookSendResult> {
  let target: SafeWebhookTarget;
  try {
    target = await resolveSafeWebhookUrl(rawUrl, resolver);
  } catch (error) {
    return {
      success: false,
      statusCode: null,
      error: error instanceof Error ? error.message : 'Unsafe webhook URL',
    };
  }

  return postSignedWebhook(target, secret, rawBody, meta);
}

// ─── Endpoint management ──────────────────────────────────────────────────────

const ENDPOINT_SELECT = {
  id: true,
  url: true,
  events: true,
  status: true,
  failure_count: true,
  last_delivery_at: true,
  created_by: true,
  created_at: true,
  updated_at: true,
} as const;

type EndpointRow = {
  id: string;
  url: string;
  events: Prisma.JsonValue;
  status: WebhookStatus;
  failure_count: number;
  last_delivery_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type WebhookEndpointSummary = {
  id: string;
  url: string;
  events: WebhookEventName[];
  status: WebhookStatus;
  failure_count: number;
  last_delivery_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

function toEndpointSummary(row: EndpointRow): WebhookEndpointSummary {
  return {
    id: row.id,
    url: row.url,
    events: eventsFromJson(row.events),
    status: row.status,
    failure_count: row.failure_count,
    last_delivery_at: row.last_delivery_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listWebhookEndpoints(organizationId: string): Promise<WebhookEndpointSummary[]> {
  const rows = await db.webhookEndpoint.findMany({
    where: { organization_id: organizationId },
    select: ENDPOINT_SELECT,
    orderBy: { created_at: 'desc' },
  });

  return rows.map(toEndpointSummary);
}

export async function getWebhookEndpoint(
  id: string,
  organizationId: string,
): Promise<WebhookEndpointSummary> {
  const row = await db.webhookEndpoint.findFirst({
    where: { id, organization_id: organizationId },
    select: ENDPOINT_SELECT,
  });

  if (!row) {
    throw new WebhookEndpointNotFoundError();
  }

  return toEndpointSummary(row);
}

export async function createWebhookEndpoint(input: {
  organizationId: string;
  createdBy: string;
  url: string;
  events: WebhookEventName[];
  status?: WebhookStatus;
}): Promise<WebhookEndpointSummary & { secret: string }> {
  const safeUrl = await assertSafeWebhookUrl(input.url);
  const secret = generateWebhookSecret();
  const events = normalizeEvents(input.events);

  const row = await db.$transaction(async (tx) => {
    const count = await tx.webhookEndpoint.count({
      where: { organization_id: input.organizationId },
    });

    if (count >= MAX_WEBHOOK_ENDPOINTS_PER_ORG) {
      throw new WebhookEndpointLimitError();
    }

    return tx.webhookEndpoint.create({
      data: {
        organization_id: input.organizationId,
        created_by: input.createdBy,
        url: safeUrl,
        secret: encryptField(secret),
        events: events as Prisma.InputJsonValue,
        status: input.status ?? WebhookStatus.active,
      },
      select: ENDPOINT_SELECT,
    });
  });

  // The plaintext signing secret is returned once here and never listed again.
  return { ...toEndpointSummary(row), secret };
}

export async function updateWebhookEndpoint(
  id: string,
  organizationId: string,
  patch: { url?: string; events?: WebhookEventName[]; status?: WebhookStatus },
): Promise<WebhookEndpointSummary> {
  const existing = await db.webhookEndpoint.findFirst({
    where: { id, organization_id: organizationId },
    select: { id: true },
  });

  if (!existing) {
    throw new WebhookEndpointNotFoundError();
  }

  const safeUrl = patch.url === undefined ? undefined : await assertSafeWebhookUrl(patch.url);

  await db.webhookEndpoint.updateMany({
    where: { id, organization_id: organizationId },
    data: {
      ...(safeUrl !== undefined ? { url: safeUrl, failure_count: 0 } : {}),
      ...(patch.events !== undefined
        ? { events: normalizeEvents(patch.events) as Prisma.InputJsonValue }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      // Re-activating clears the failure streak that paused the endpoint.
      ...(patch.status === WebhookStatus.active ? { failure_count: 0 } : {}),
    },
  });

  return getWebhookEndpoint(id, organizationId);
}

export async function setWebhookEndpointStatus(
  id: string,
  organizationId: string,
  status: WebhookStatus,
): Promise<WebhookEndpointSummary> {
  return updateWebhookEndpoint(id, organizationId, { status });
}

export async function rotateWebhookEndpointSecret(
  id: string,
  organizationId: string,
): Promise<WebhookEndpointSummary & { secret: string }> {
  const secret = generateWebhookSecret();

  const updated = await db.webhookEndpoint.updateMany({
    where: { id, organization_id: organizationId },
    data: { secret: encryptField(secret) },
  });

  if (updated.count !== 1) {
    throw new WebhookEndpointNotFoundError();
  }

  return { ...(await getWebhookEndpoint(id, organizationId)), secret };
}

export async function deleteWebhookEndpoint(
  id: string,
  organizationId: string,
): Promise<{ id: string }> {
  const existing = await db.webhookEndpoint.findFirst({
    where: { id, organization_id: organizationId },
    select: { id: true },
  });

  if (!existing) {
    throw new WebhookEndpointNotFoundError();
  }

  await db.$transaction([
    db.webhookDelivery.deleteMany({
      where: { endpoint_id: id, organization_id: organizationId },
    }),
    db.webhookEndpoint.deleteMany({
      where: { id, organization_id: organizationId },
    }),
  ]);

  return { id };
}

export type WebhookDeliverySummary = {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  response_status: number | null;
  error_message: string | null;
  next_attempt_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
};

export async function listWebhookDeliveries(
  endpointId: string,
  organizationId: string,
  options: { page: number; perPage: number; status?: WebhookDeliveryStatus },
): Promise<{ data: WebhookDeliverySummary[]; total: number }> {
  const endpoint = await db.webhookEndpoint.findFirst({
    where: { id: endpointId, organization_id: organizationId },
    select: { id: true },
  });

  if (!endpoint) {
    throw new WebhookEndpointNotFoundError();
  }

  const where: Prisma.WebhookDeliveryWhereInput = {
    organization_id: organizationId,
    endpoint_id: endpointId,
    ...(options.status ? { status: options.status } : {}),
  };

  const [total, rows] = await Promise.all([
    db.webhookDelivery.count({ where }),
    db.webhookDelivery.findMany({
      where,
      select: {
        id: true,
        endpoint_id: true,
        event_type: true,
        status: true,
        attempts: true,
        response_status: true,
        error_message: true,
        next_attempt_at: true,
        delivered_at: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      skip: (options.page - 1) * options.perPage,
      take: options.perPage,
    }),
  ]);

  return { data: rows, total };
}

// ─── Delivery worker (driven by scheduler.ts) ─────────────────────────────────

function safeDeliveryError(error: string | null): string | null {
  return error ? error.slice(0, WEBHOOK_ERROR_MAX_LENGTH) : null;
}

/** Increment the endpoint's failure streak and pause it once it crosses the threshold. */
export async function recordWebhookEndpointFailure(
  endpointId: string,
  organizationId: string,
  threshold: number = getWebhookFailurePauseThreshold(),
): Promise<boolean> {
  const incremented = await db.webhookEndpoint.updateMany({
    where: { id: endpointId, organization_id: organizationId, status: WebhookStatus.active },
    data: { failure_count: { increment: 1 } },
  });

  if (incremented.count !== 1) {
    return false;
  }

  const paused = await db.webhookEndpoint.updateMany({
    where: {
      id: endpointId,
      organization_id: organizationId,
      status: WebhookStatus.active,
      failure_count: { gte: threshold },
    },
    data: { status: WebhookStatus.paused },
  });

  return paused.count === 1;
}

async function processWebhookDelivery(
  candidate: { id: string; organization_id: string },
  now: Date,
): Promise<void> {
  // Atomic claim: only the worker that flips next_attempt_at into the future wins,
  // and a worker that dies mid-send releases the row when the lease expires.
  //
  // The lease is measured from HERE, not from `now`. This is the same defect that was fixed
  // for the mailer in services/sequences.ts (processEnrollment) and it was still live on this
  // side: `now` is captured once when the tick starts (runWebhookDeliveryTick's default
  // argument) and the tick then scans up to WEBHOOK_TICK_SCAN_SIZE rows, walks every
  // organization that has due work, and awaits up to WEBHOOK_TICK_BATCH_SIZE deliveries per
  // org in waves of WEBHOOK_SEND_CONCURRENCY with a WEBHOOK_TIMEOUT_MS deadline on each. A
  // single org with a full batch of dead endpoints is already 100/5 × 10 s = 200 s; a handful
  // of such orgs puts the tick well past the 5-minute lease. Written as `now + 5 min`, the
  // lease was then ALREADY IN THE PAST at the moment it was stored: the row still read as due,
  // the next 60 s tick re-claimed it while this one was still mid-POST, and the customer's
  // endpoint received the same event twice. Worse, each re-claim increments `attempts`, so the
  // delivery burns through MAX_WEBHOOK_ATTEMPTS without ever having failed and
  // recordWebhookEndpointFailure() eventually pauses a perfectly healthy endpoint.
  //
  // The `where` still tests against `now`, deliberately: the row has to have been due when
  // this tick decided to look at it, so a row that another worker has already leased — or that
  // has been rescheduled, delivered or failed in the meantime — cannot be stolen back.
  const claimedAt = new Date();
  const claimed = await db.webhookDelivery.updateMany({
    where: {
      id: candidate.id,
      organization_id: candidate.organization_id,
      status: WebhookDeliveryStatus.pending,
      next_attempt_at: { lte: now },
    },
    data: {
      attempts: { increment: 1 },
      next_attempt_at: new Date(claimedAt.getTime() + WEBHOOK_LEASE_MS),
    },
  });

  if (claimed.count !== 1) {
    return;
  }

  const delivery = await db.webhookDelivery.findFirst({
    where: { id: candidate.id, organization_id: candidate.organization_id },
    select: { id: true, endpoint_id: true, event_type: true, payload: true, attempts: true },
  });

  if (!delivery) {
    return;
  }

  const endpoint = await db.webhookEndpoint.findFirst({
    where: {
      id: delivery.endpoint_id,
      organization_id: candidate.organization_id,
      status: WebhookStatus.active,
    },
    select: { id: true, url: true, secret: true },
  });

  if (!endpoint) {
    await db.webhookDelivery.updateMany({
      where: { id: delivery.id, organization_id: candidate.organization_id },
      data: {
        status: WebhookDeliveryStatus.failed,
        error_message: 'Webhook endpoint is paused or no longer exists',
        next_attempt_at: null,
      },
    });
    return;
  }

  const rawBody = JSON.stringify(delivery.payload ?? {});

  let result: WebhookSendResult;
  try {
    result = await sendSignedWebhook(endpoint.url, decryptField(endpoint.secret), rawBody, {
      event: delivery.event_type,
      deliveryId: delivery.id,
    });
  } catch (error) {
    result = {
      success: false,
      statusCode: null,
      error: error instanceof Error ? error.message : 'Webhook delivery failed',
    };
  }

  const completedAt = new Date();

  if (result.success) {
    await db.webhookDelivery.updateMany({
      where: { id: delivery.id, organization_id: candidate.organization_id },
      data: {
        status: WebhookDeliveryStatus.success,
        response_status: result.statusCode,
        error_message: null,
        delivered_at: completedAt,
        next_attempt_at: null,
      },
    });
    await db.webhookEndpoint.updateMany({
      where: { id: endpoint.id, organization_id: candidate.organization_id },
      data: { failure_count: 0, last_delivery_at: completedAt },
    });
    return;
  }

  const retryAt = nextWebhookAttemptAt(delivery.attempts, completedAt);

  if (retryAt) {
    await db.webhookDelivery.updateMany({
      where: { id: delivery.id, organization_id: candidate.organization_id },
      data: {
        status: WebhookDeliveryStatus.pending,
        response_status: result.statusCode,
        error_message: safeDeliveryError(result.error),
        next_attempt_at: retryAt,
      },
    });
    await db.webhookEndpoint.updateMany({
      where: { id: endpoint.id, organization_id: candidate.organization_id },
      data: { last_delivery_at: completedAt },
    });
    return;
  }

  await db.webhookDelivery.updateMany({
    where: { id: delivery.id, organization_id: candidate.organization_id },
    data: {
      status: WebhookDeliveryStatus.failed,
      response_status: result.statusCode,
      error_message: safeDeliveryError(result.error),
      next_attempt_at: null,
    },
  });
  await db.webhookEndpoint.updateMany({
    where: { id: endpoint.id, organization_id: candidate.organization_id },
    data: { last_delivery_at: completedAt },
  });
  await recordWebhookEndpointFailure(endpoint.id, candidate.organization_id);
}

/**
 * One pass over due deliveries. Called from startScheduler()'s existing 60 s interval.
 * The only cross-org read is the org-discovery query below; every read and write that
 * touches endpoint or delivery rows is scoped by organization_id.
 */
export async function runWebhookDeliveryTick(now: Date = new Date()): Promise<void> {
  // Oldest-due first, so no organization can starve the others. Prisma's `distinct`
  // is applied in memory after `take`, so the de-duplication is done here instead.
  const dueRows = await db.webhookDelivery.findMany({
    where: { status: WebhookDeliveryStatus.pending, next_attempt_at: { lte: now } },
    select: { organization_id: true },
    orderBy: { next_attempt_at: 'asc' },
    take: WEBHOOK_TICK_SCAN_SIZE,
  });

  const organizationIds = [...new Set(dueRows.map((row) => row.organization_id))];

  for (const organizationId of organizationIds) {
    const candidates = await db.webhookDelivery.findMany({
      where: {
        organization_id: organizationId,
        status: WebhookDeliveryStatus.pending,
        next_attempt_at: { lte: now },
      },
      select: { id: true, organization_id: true },
      orderBy: { next_attempt_at: 'asc' },
      take: WEBHOOK_TICK_BATCH_SIZE,
    });

    for (let index = 0; index < candidates.length; index += WEBHOOK_SEND_CONCURRENCY) {
      const batch = candidates.slice(index, index + WEBHOOK_SEND_CONCURRENCY);
      await Promise.all(batch.map((candidate) => processWebhookDelivery(candidate, now).catch((error) => {
        console.error('[webhooks] delivery attempt failed', error);
      })));
    }
  }
}
