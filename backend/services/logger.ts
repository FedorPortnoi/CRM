import winston from 'winston';

/**
 * Central structured logger for everything that isn't inside a Fastify request
 * (background jobs — amoCRM sync, scheduler, push fan-out — plus the /debug/log
 * intake for mobile-reported errors). Request-scoped code should keep using
 * request.log / server.log (Fastify's built-in pino instance); this exists for
 * the code that has no request to hang a logger off.
 *
 * Console transport only — PM2 already captures each process's stdout/stderr
 * into logs/<name>-out-N.log / logs/<name>-error-N.log (see
 * deploy/local/ecosystem.config.js). stderrLevels routes 'error' to stderr so
 * it actually lands in the *-error log instead of mixing into *-out with
 * everything else.
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console({ stderrLevels: ['error'] })],
});

export type LogMeta = Record<string, unknown>;

function emit(level: 'debug' | 'info' | 'warn' | 'error', tag: string, message: string, meta?: LogMeta): void {
  logger.log(level, message, { tag, ...meta });
}

export const log = {
  debug: (tag: string, message: string, meta?: LogMeta) => emit('debug', tag, message, meta),
  info: (tag: string, message: string, meta?: LogMeta) => emit('info', tag, message, meta),
  warn: (tag: string, message: string, meta?: LogMeta) => emit('warn', tag, message, meta),
  error: (tag: string, message: string, meta?: LogMeta) => emit('error', tag, message, meta),
};
