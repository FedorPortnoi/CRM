/**
 * RuStore Push (VK Push Notification Service) server transport.
 *
 * Why this exists: Android builds installed from RuStore frequently have no Google Play
 * Services at all. FCM does not fail loudly on such a device — it accepts the send and
 * delivers nothing. Anything that depends on a push arriving (reminders, chat) is therefore
 * silently dead for a large share of the Russian install base until the transport moves here.
 *
 * Server API, as documented by RuStore (see the report for sources):
 *
 *   POST https://vkpns.rustore.ru/v1/projects/{project_id}/messages:send
 *   Authorization: Bearer {service-token}
 *   Content-Type: application/json
 *
 *   { "message": { "token", "notification": { "title", "body", "image" },
 *                  "data": { ... }, "android": { "ttl", "notification": { ... } } } }
 *
 *   200 -> {}
 *   error -> { "error": { "code": <http status>, "message": "...", "status": "<SYMBOL>" } }
 *
 *   INVALID_ARGUMENT   400  bad request parameters (also: malformed registration token)
 *   PERMISSION_DENIED  401  wrong service token  <- CONFIG fault, never a device fault
 *   NOT_FOUND          404  "Requested entity was not found." -> token expired/unregistered
 *   TOO_MANY_REQUESTS  429  throttled
 *   INTERNAL           500  provider fault
 *
 * Both `project_id` and `service token` come from RuStore Console -> app -> Push
 * notifications -> Projects.
 */

export type RuStorePushResult =
  | { ok: true }
  | { ok: false; code: 'DEVICE_NOT_REGISTERED'; message: string }
  | { ok: false; code: 'SEND_FAILED'; message: string };

/**
 * RuStore documents a hard 4096-byte ceiling on the whole message. Truncating the body is
 * better than a 400 that looks like a transport outage in the logs.
 */
const MAX_MESSAGE_BYTES = 4096;

const DEFAULT_BASE_URL = 'https://vkpns.rustore.ru';

/**
 * Read at call time, not at module load. The FCM block above reads at load, which means a
 * deployment that sets the variable after import silently keeps the empty value; more
 * practically it makes this module untestable without re-importing it.
 */
function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

export function ruStoreProjectId(): string {
  return env('RUSTORE_PROJECT_ID');
}

export function ruStoreServiceToken(): string {
  return env('RUSTORE_SERVICE_TOKEN');
}

export function ruStoreBaseUrl(): string {
  return env('RUSTORE_API_BASE_URL') || DEFAULT_BASE_URL;
}

/** True when this deployment has enough configuration to reach RuStore at all. */
export function isRuStoreConfigured(): boolean {
  return Boolean(ruStoreProjectId() && ruStoreServiceToken());
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let out = value;
  while (out.length > 0 && byteLength(out) > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

type RuStoreErrorBody = {
  error?: { code?: number; message?: string; status?: string };
};

/**
 * Decide whether an error means "this device's token is dead" (prune it) or "the send
 * failed" (keep it, retry later).
 *
 * The distinction matters more than it looks. PERMISSION_DENIED means OUR service token is
 * wrong — treating that as a device fault would delete every PushDevice row in the table on
 * the first tick after a credential rotation, and no rollback restores tokens. So the
 * unregistered set is deliberately narrow.
 */
export function classifyRuStoreError(status: number, body: RuStoreErrorBody | null): RuStorePushResult {
  const errStatus = body?.error?.status ?? '';
  const message = body?.error?.message ?? `HTTP ${status}`;

  // 404 NOT_FOUND — "Requested entity was not found." This is the documented shape for a
  // token that has expired or been revoked.
  if (status === 404 || errStatus === 'NOT_FOUND') {
    return { ok: false, code: 'DEVICE_NOT_REGISTERED', message };
  }

  // 400 INVALID_ARGUMENT is overloaded: it covers both a malformed *request* and a malformed
  // *registration token*. Only the latter is a device fault, and the only signal separating
  // them is the message text.
  // VERIFY: the exact message strings RuStore emits for a bad token. The documented example
  // is "The registration token is not a valid FCM registration token" (RuStore proxies FCM
  // wording here). If production shows a different phrasing, widen this list — a missed
  // phrase leaves a dead token being retried forever, which is the safe direction to fail.
  if (status === 400 || errStatus === 'INVALID_ARGUMENT') {
    const lowered = message.toLowerCase();
    const looksLikeTokenFault =
      lowered.includes('registration token') ||
      lowered.includes('not a valid') ||
      lowered.includes('invalid token');
    if (looksLikeTokenFault) {
      return { ok: false, code: 'DEVICE_NOT_REGISTERED', message };
    }
  }

  // PERMISSION_DENIED / TOO_MANY_REQUESTS / INTERNAL / anything unrecognised: our problem or
  // a transient one. Never prune.
  return { ok: false, code: 'SEND_FAILED', message: `${errStatus || status}: ${message}` };
}

export type RuStoreSendOptions = {
  /** Android notification channel id. Must match a channel the client created. */
  channelId?: string;
  /** Seconds the push may sit on the server. RuStore's default is 4 weeks. */
  ttlSeconds?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Send one notification to one RuStore token.
 *
 * Returns a result rather than throwing so the router can classify without string-matching
 * exception messages, which is how the FCM path currently detects unregistered devices and
 * is why it misfires.
 */
export async function sendRuStorePush(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
  options: RuStoreSendOptions = {},
): Promise<RuStorePushResult> {
  const projectId = ruStoreProjectId();
  const serviceToken = ruStoreServiceToken();

  if (!projectId || !serviceToken) {
    return {
      ok: false,
      code: 'SEND_FAILED',
      message: 'RuStore push is not configured (RUSTORE_PROJECT_ID / RUSTORE_SERVICE_TOKEN)',
    };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const url = `${ruStoreBaseUrl().replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(projectId)}/messages:send`;

  // RuStore requires data values to be strings, like FCM.
  const stringData = data
    ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
    : undefined;

  const notification: Record<string, unknown> = { title, body };

  const message: Record<string, unknown> = {
    token,
    notification,
    ...(stringData && Object.keys(stringData).length > 0 ? { data: stringData } : {}),
    android: {
      // VERIFY: RuStore documents `ttl` as a duration string ("3.5s"), mirroring FCM's
      // google.protobuf.Duration encoding. Emitted only when explicitly requested so the
      // provider default (4 weeks) applies otherwise.
      ...(options.ttlSeconds !== undefined ? { ttl: `${options.ttlSeconds}s` } : {}),
      notification: {
        title,
        body,
        ...(options.channelId ? { channel_id: options.channelId } : {}),
      },
    },
  };

  let payload = JSON.stringify({ message });

  if (byteLength(payload) > MAX_MESSAGE_BYTES) {
    const overflow = byteLength(payload) - MAX_MESSAGE_BYTES;
    const shortBody = truncateToBytes(body, Math.max(0, byteLength(body) - overflow - 8));
    notification.body = shortBody;
    (message.android as { notification: Record<string, unknown> }).notification.body = shortBody;
    payload = JSON.stringify({ message });
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        'Content-Type': 'application/json',
      },
      body: payload,
    });
  } catch (err: unknown) {
    return {
      ok: false,
      code: 'SEND_FAILED',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.ok) return { ok: true };

  let parsed: RuStoreErrorBody | null = null;
  try {
    parsed = (await res.json()) as RuStoreErrorBody;
  } catch {
    parsed = null;
  }

  return classifyRuStoreError(res.status, parsed);
}
