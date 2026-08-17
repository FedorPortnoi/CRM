import { API_URL } from './api';

/**
 * Ships uncaught errors and console.error calls to the app's own backend
 * (POST /debug/log — see backend/api/routes/debug-log.ts), so a crash on a
 * real device shows up in the same log stream as the API's own errors
 * instead of vanishing into a phone nobody can plug into a debugger.
 *
 * Self-hosted on purpose, not a third-party crash SDK: this project's
 * Russia-only-providers rule (see crm-now.md §11) already carved out
 * @sentry/react-native (src/utils/sentry.ts) as an opt-in escape hatch that
 * stays off unless EXPO_PUBLIC_SENTRY_DSN is set. This is the always-on,
 * compliant default — it never leaves infrastructure this project already
 * controls.
 */

const DEBUG_LOG_URL = `${API_URL.replace(/\/api\/v1\/?$/, '')}/debug/log`;
const MAX_MESSAGE_LENGTH = 2000;
const SEND_WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 20;

let installed = false;
let forwarding = false;
let windowStart = 0;
let windowCount = 0;

function truncate(value: string): string {
  return value.length > MAX_MESSAGE_LENGTH ? `${value.slice(0, MAX_MESSAGE_LENGTH)}…` : value;
}

function stringifyError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

function allowSend(): boolean {
  const now = Date.now();
  if (now - windowStart > SEND_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount += 1;
  return windowCount <= MAX_SENDS_PER_WINDOW;
}

function send(level: 'warn' | 'error', message: string, context?: Record<string, unknown>): void {
  // Reentrancy guard: if the fetch below itself ever triggers a console.error
  // (it shouldn't — failures are caught, not logged), this stops that from
  // looping back into send() forever.
  if (forwarding || !allowSend()) return;
  forwarding = true;
  fetch(DEBUG_LOG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, tag: 'mobile', message: truncate(message), context }),
  })
    .catch(() => {
      // Best-effort — if the API is unreachable there is nowhere useful to report that.
    })
    .finally(() => {
      forwarding = false;
    });
}

type RNErrorHandler = (error: unknown, isFatal?: boolean) => void;

export function initRemoteLogger(): void {
  if (installed) return;
  installed = true;

  const globalWithErrorUtils = global as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => RNErrorHandler;
      setGlobalHandler?: (handler: RNErrorHandler) => void;
    };
    addEventListener?: (type: string, listener: (event: { reason?: unknown }) => void) => void;
  };

  const errorUtils = globalWithErrorUtils.ErrorUtils;
  if (errorUtils?.setGlobalHandler && errorUtils.getGlobalHandler) {
    const previousHandler = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      const { message, stack } = stringifyError(error);
      send('error', message, { stack, isFatal: Boolean(isFatal), source: 'uncaught' });
      previousHandler?.(error, isFatal);
    });
  }

  // Hermes on recent RN versions dispatches this for rejected promises with no
  // .catch(); older versions simply won't fire it, which is a fine, silent no-op.
  globalWithErrorUtils.addEventListener?.('unhandledrejection', (event) => {
    const { message, stack } = stringifyError(event?.reason);
    send('error', message, { stack, source: 'unhandledrejection' });
  });

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    const message = args
      .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack ?? ''}` : String(arg)))
      .join(' ');
    send('error', message, { source: 'console.error' });
  };
}
