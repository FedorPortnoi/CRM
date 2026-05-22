import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { __prisma: PrismaClient };

export const db = globalForPrisma.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = db;
}

// Warn at startup if SSL cert path is configured but not wired into DATABASE_URL.
if (
  process.env.YANDEX_DB_SSL_CA &&
  process.env.DATABASE_URL &&
  !process.env.DATABASE_URL.includes('sslrootcert')
) {
  console.warn(
    '[db] YANDEX_DB_SSL_CA is set but DATABASE_URL does not include sslrootcert=. ' +
      'Set PGSSLROOTCERT env var or append ?sslmode=require&sslrootcert=<path> to DATABASE_URL.',
  );
}
