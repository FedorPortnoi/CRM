import * as Sentry from '@sentry/react-native';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

const PII_KEYS = new Set([
  'email', 'phone', 'mobile', 'password', 'token', 'secret',
  'access_token', 'refresh_token', 'push_token', 'device_token',
]);

function stripPii(obj: unknown, depth = 0): unknown {
  if (depth > 5 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => stripPii(v, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = PII_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : stripPii(v, depth + 1);
  }
  return result;
}

export function initSentry(): void {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: process.env.APP_ENV ?? 'development',
    tracesSampleRate: process.env.APP_ENV === 'production' ? 0.1 : 0,
    beforeSend(event: Sentry.ErrorEvent) {
      if (Array.isArray(event.breadcrumbs)) {
        event.breadcrumbs = event.breadcrumbs.map((b) => ({
          ...b,
          data: b.data ? (stripPii(b.data) as Record<string, unknown>) : b.data,
        }));
      }
      if (event.extra) {
        event.extra = stripPii(event.extra) as Record<string, unknown>;
      }
      return event;
    },
  });
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!DSN) return;
  Sentry.withScope((scope) => {
    if (context) scope.setExtras(stripPii(context) as Record<string, unknown>);
    Sentry.captureException(error);
  });
}
