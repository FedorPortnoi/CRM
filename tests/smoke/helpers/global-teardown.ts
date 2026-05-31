import * as fs from "fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { AUTH_STATE_PATH } from "./auth";

type AuthState = {
  orgId?: string;
  runStartedAt?: string;
};

const TEST_EMAIL_DOMAINS = ["@test.com", "@example.com", "@x.com"];

function isLocalDatabaseHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function getSafeCleanupDatabaseUrl(): string | null {
  const databaseUrl =
    process.env.SMOKE_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    console.warn("Skipping smoke org cleanup: DATABASE_URL is invalid.");
    return null;
  }

  const databaseName = parsed.pathname.replace(/^\/+/, "");
  const isSafeDatabase =
    /(test|smoke)/i.test(databaseName) || isLocalDatabaseHost(parsed.hostname);
  if (
    isSafeDatabase ||
    process.env.SMOKE_CLEANUP_ALLOW_NON_TEST_DB === "true"
  ) {
    return databaseUrl;
  }

  console.warn(
    "Skipping smoke org cleanup: database is not local or named like a test DB.",
  );
  return null;
}

function readAuthState(): AuthState | null {
  try {
    return JSON.parse(fs.readFileSync(AUTH_STATE_PATH, "utf-8")) as AuthState;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(
        `Skipping smoke org cleanup: cannot read auth state (${code ?? "unknown error"}).`,
      );
    }
    return null;
  }
}

function uuidList(ids: string[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

async function deleteSmokeOrgs(
  db: PrismaClient,
  orgIds: string[],
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`UPDATE organizations SET owner_id = NULL WHERE id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`UPDATE "User" SET invited_by = NULL WHERE invited_by IN (SELECT id FROM "User" WHERE organization_id IN (${uuidList(orgIds)}))`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "UserCalendarSync" WHERE user_id IN (SELECT id FROM "User" WHERE organization_id IN (${uuidList(orgIds)}))`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "AuthSession" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "AuditEvent" WHERE organization_id IN (${uuidList(orgIds)}) OR user_id IN (SELECT id FROM "User" WHERE organization_id IN (${uuidList(orgIds)}))`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "PendingCapture" WHERE org_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "WorkflowRun" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "Workflow" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "Message" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "CalendarEvent" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "Task" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "Deal" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "PipelineStage" WHERE pipeline_id IN (SELECT id FROM "Pipeline" WHERE organization_id IN (${uuidList(orgIds)}))`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "Pipeline" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "Contact" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "User" WHERE organization_id IN (${uuidList(orgIds)})`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM organizations WHERE id IN (${uuidList(orgIds)})`,
    );
  });
}

async function cleanupSmokeOrgs(authState: AuthState | null): Promise<void> {
  const databaseUrl = getSafeCleanupDatabaseUrl();
  if (!databaseUrl) return;

  process.env.DATABASE_URL = databaseUrl;
  const db = new PrismaClient();

  try {
    const runStartedAt = authState?.runStartedAt
      ? new Date(authState.runStartedAt)
      : null;
    const validRunStartedAt =
      runStartedAt && !Number.isNaN(runStartedAt.getTime())
        ? runStartedAt
        : null;
    const orgFilters: Prisma.OrgWhereInput[] = [];

    if (authState?.orgId) {
      orgFilters.push({ id: authState.orgId });
    }

    if (validRunStartedAt) {
      orgFilters.push({
        created_at: { gte: validRunStartedAt },
        users: {
          some: {
            OR: TEST_EMAIL_DOMAINS.map((domain) => ({
              email: { endsWith: domain },
            })),
          },
        },
      });
    }

    if (orgFilters.length === 0) {
      return;
    }

    const orgs = await db.org.findMany({
      where: {
        OR: orgFilters,
      },
      select: { id: true },
    });

    const orgIds = orgs.map((org) => org.id);
    if (orgIds.length > 0) {
      await deleteSmokeOrgs(db, orgIds);
    }
  } finally {
    await db.$disconnect();
  }
}

export default async function globalTeardown() {
  const authState = readAuthState();

  try {
    await cleanupSmokeOrgs(authState);
  } finally {
    fs.rmSync(AUTH_STATE_PATH, { force: true });
  }
}
