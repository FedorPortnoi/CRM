const { PrismaClient } = require('./node_modules/@prisma/client');
const db = new PrismaClient({
  datasources: { db: { url: 'postgresql://postgres.tiufcjxeiorvteuypaxl:HofstraNY2026@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connect_timeout=10' } }
});

async function run() {
  await db.$connect();
  console.log('Connected');

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AuthSession" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "organization_id" UUID NOT NULL,
      "user_id" UUID NOT NULL,
      "token_hash" TEXT NOT NULL,
      "user_agent" TEXT,
      "ip_address" TEXT,
      "revoked_at" TIMESTAMP(3),
      "revoked_reason" TEXT,
      "last_seen_at" TIMESTAMP(3),
      "expires_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
    )
  `);
  console.log('AuthSession OK');

  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "AuthSession_token_hash_key" ON "AuthSession"("token_hash")`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuthSession_user_id_revoked_at_idx" ON "AuthSession"("user_id", "revoked_at")`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuthSession_organization_id_created_at_idx" ON "AuthSession"("organization_id", "created_at")`);

  // Add FK constraints only if not already present
  await db.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuthSession_organization_id_fkey') THEN
        ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_organization_id_fkey"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$
  `);
  await db.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuthSession_user_id_fkey') THEN
        ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_user_id_fkey"
          FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$
  `);
  console.log('AuthSession indexes + FKs OK');

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AuditEvent" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "organization_id" UUID,
      "user_id" UUID,
      "action" TEXT NOT NULL,
      "outcome" TEXT NOT NULL DEFAULT 'success',
      "target_type" TEXT,
      "target_id" TEXT,
      "ip_address" TEXT,
      "user_agent" TEXT,
      "metadata" JSONB,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
    )
  `);
  console.log('AuditEvent OK');

  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuditEvent_organization_id_created_at_idx" ON "AuditEvent"("organization_id", "created_at")`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuditEvent_user_id_created_at_idx" ON "AuditEvent"("user_id", "created_at")`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuditEvent_action_created_at_idx" ON "AuditEvent"("action", "created_at")`);

  await db.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuditEvent_organization_id_fkey') THEN
        ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organization_id_fkey"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$
  `);
  await db.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuditEvent_user_id_fkey') THEN
        ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_user_id_fkey"
          FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$
  `);
  console.log('AuditEvent indexes + FKs OK');

  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  console.log('All tables:', tables.map(t => t.tablename).join(', '));

  await db.$disconnect();
  console.log('Done');
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
