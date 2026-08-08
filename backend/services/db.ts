import { PrismaClient } from '@prisma/client';
import { withTenantScope } from './tenant-scope';

const globalForPrisma = global as unknown as { __prisma: PrismaClient };

// Every query in the backend goes through this one client, which is why the
// tenant guard is installed here and not at any call site. See tenant-scope.ts
// for what it checks, why it only REPORTS in production, and why PostgreSQL
// row-level security was rejected rather than deferred.
//
// The wrapper is transparent: it adds no methods and changes no result shapes,
// so `db` keeps its plain PrismaClient type and nothing downstream re-types.
export const db: PrismaClient = globalForPrisma.__prisma ?? withTenantScope(new PrismaClient());

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = db;
}
