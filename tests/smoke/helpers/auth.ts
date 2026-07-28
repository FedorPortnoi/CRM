import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { getSmokeDatabaseUrl } from "./database";

export interface AuthState {
  token: string;
  userId: string;
  email: string;
  orgId?: string;
  runStartedAt?: string;
}

export const AUTH_STATE_PATH = path.resolve(__dirname, "../.auth.json");

export function getAuth(): AuthState {
  return JSON.parse(fs.readFileSync(AUTH_STATE_PATH, "utf-8"));
}

type VerifyRegisteredSmokeUserInput = {
  userId: string;
  email: string;
  runStartedAt: string;
};

export async function verifyRegisteredSmokeUser({
  userId,
  email,
  runStartedAt,
}: VerifyRegisteredSmokeUserInput): Promise<{ orgId: string }> {
  if (!/@(?:test|example)\.com$/i.test(email)) {
    throw new Error("Refusing to bypass OTP for an email outside the smoke test domains.");
  }

  const startedAt = new Date(runStartedAt);
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error("Cannot verify a smoke user without a valid run start timestamp.");
  }

  const databaseUrl = getSmokeDatabaseUrl();
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        organization_id: true,
        created_at: true,
        is_verified: true,
      },
    });

    if (!user || user.email?.toLowerCase() !== email.toLowerCase()) {
      throw new Error("The newly registered smoke user was not found in the configured smoke database.");
    }
    if (user.created_at < startedAt) {
      throw new Error("Refusing to verify a user that predates this smoke run.");
    }
    if (user.is_verified) {
      throw new Error("The newly registered smoke user was unexpectedly already verified.");
    }

    const result = await db.user.updateMany({
      where: {
        id: userId,
        email,
        is_verified: false,
        created_at: { gte: startedAt },
      },
      data: {
        is_verified: true,
        email_verified: true,
        phone_verified: true,
      },
    });

    if (result.count !== 1) {
      throw new Error("Smoke OTP bypass did not update exactly one newly registered user.");
    }

    return { orgId: user.organization_id };
  } finally {
    await db.$disconnect();
  }
}

export const SMOKE_ORG_PASSWORD = "Password123!";
export const SMOKE_ORG_PHONE = "+70000000000";

export interface RegisteredOrgUser {
  id: string;
  email: string | null;
  username?: string | null;
  name: string;
  role: string;
  org_id: string;
  manager_id?: string | null;
  onboarding_completed?: boolean;
  must_change_password?: boolean;
  must_change_email?: boolean;
}

export interface RegisteredOrg {
  token: string;
  userId: string;
  orgId: string;
  email: string;
  password: string;
  name: string;
  orgName: string;
  phone: string;
  /** The login response's `data.user`, for specs that assert on the user shape. */
  user: RegisteredOrgUser;
  /** Timestamp captured before registering; passed to verifyRegisteredSmokeUser. */
  runStartedAt: string;
}

export interface RegisterVerifiedOrgOverrides {
  email?: string;
  password?: string;
  name?: string;
  orgName?: string;
  phone?: string;
}

let smokeOrgCounter = 0;

/** Matches the `${unique}@example.com` shape the specs already use, and stays inside the
 *  smoke domains that verifyRegisteredSmokeUser will accept. */
function uniqueSmokeEmail(suffix: string): string {
  smokeOrgCounter += 1;
  const unique = `${suffix}-${Date.now()}-${smokeOrgCounter}-${Math.random().toString(36).slice(2)}`;
  // The API lowercases emails on the way in; the DB-side guard matches exactly, so normalise here.
  return `${unique}@example.com`.toLowerCase();
}

/** Full response body, clipped only for use inside an error message. */
async function describeResponse(res: APIResponse): Promise<string> {
  try {
    const raw = await res.text();
    return raw.length > 500 ? `${raw.slice(0, 500)}… (${raw.length} bytes)` : raw;
  } catch {
    return "<response body could not be read>";
  }
}

async function readJson(res: APIResponse, step: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await res.text();
  } catch (err) {
    throw new Error(
      `registerVerifiedOrg: ${step} returned ${res.status()} but its body could not be read: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    const clipped = raw.length > 500 ? `${raw.slice(0, 500)}… (${raw.length} bytes)` : raw;
    throw new Error(`registerVerifiedOrg: ${step} returned ${res.status()} with a non-JSON body: ${clipped}`);
  }
}

/**
 * Registration + OTP bypass + login, as one call, for specs that need their own org.
 *
 * Registration no longer returns a session token — it returns an OTP challenge
 * (`{ data: { user_id, email, needs_verification }, meta: { email_sent } }`) — and login is
 * rejected with 403 ACCOUNT_NOT_VERIFIED until the account is verified. This runs the only
 * sequence that works end to end:
 *
 *   register (with `phone`, which RegisterSchema requires) -> verifyRegisteredSmokeUser -> login
 *
 * Every failure throws with the step named, so a future contract change is diagnosable from
 * the failure text alone rather than a bare "expected 201, got 400".
 *
 * @example
 *   const org = await registerVerifiedOrg(request, "contacts");
 *   const res = await request.get("/api/v1/contacts", {
 *     headers: { Authorization: `Bearer ${org.token}` },
 *   });
 */
export async function registerVerifiedOrg(
  request: APIRequestContext,
  suffix: string,
  overrides: RegisterVerifiedOrgOverrides = {},
): Promise<RegisteredOrg> {
  const email = (overrides.email ?? uniqueSmokeEmail(suffix)).toLowerCase();
  const password = overrides.password ?? SMOKE_ORG_PASSWORD;
  const name = overrides.name ?? `User ${suffix}`;
  const orgName = overrides.orgName ?? `Org ${email.split("@")[0]}`;
  const phone = overrides.phone ?? SMOKE_ORG_PHONE;

  // Must be captured before registering: verifyRegisteredSmokeUser refuses to touch a user
  // whose created_at predates it. The 60s backdate absorbs app/DB clock skew.
  const runStartedAt = new Date(Date.now() - 60_000).toISOString();

  // Step 1 — register. RegisterSchema requires phone; omitting it is a 400.
  const registerRes = await request.post("/api/v1/auth/", {
    data: { email, password, name, org_name: orgName, phone },
  });
  if (registerRes.status() !== 201) {
    throw new Error(
      `registerVerifiedOrg: step 1 (register) failed for ${email} — ` +
        `POST /api/v1/auth/ expected 201, got ${registerRes.status()}: ${await describeResponse(registerRes)}`,
    );
  }

  const registerBody = (await readJson(registerRes, "step 1 (register)")) as {
    data?: { user_id?: string; email?: string; needs_verification?: boolean };
  };
  const userId = registerBody.data?.user_id;
  if (!userId || registerBody.data?.email !== email || registerBody.data.needs_verification !== true) {
    throw new Error(
      `registerVerifiedOrg: step 1 (register) succeeded for ${email} but the response did not match the ` +
        `OTP contract { data: { user_id, email, needs_verification: true } }. Got: ${JSON.stringify(registerBody)}`,
    );
  }

  // Step 2 — bypass the emailed OTP by flipping is_verified directly in the smoke database.
  let orgId: string;
  try {
    ({ orgId } = await verifyRegisteredSmokeUser({ userId, email, runStartedAt }));
  } catch (err) {
    throw new Error(
      `registerVerifiedOrg: step 2 (OTP bypass via verifyRegisteredSmokeUser) failed for ${email} ` +
        `(user_id ${userId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 3 — log in. Registration no longer returns a token; this is the only source of one.
  const loginRes = await request.post("/api/v1/auth/login", {
    data: { email, password },
  });
  if (loginRes.status() !== 200) {
    throw new Error(
      `registerVerifiedOrg: step 3 (login) failed for ${email} — ` +
        `POST /api/v1/auth/login expected 200, got ${loginRes.status()}: ${await describeResponse(loginRes)}. ` +
        `A 403 ACCOUNT_NOT_VERIFIED here means step 2 verified the wrong row.`,
    );
  }

  const loginBody = (await readJson(loginRes, "step 3 (login)")) as {
    data?: { token?: string; user?: RegisteredOrgUser };
  };
  const token = loginBody.data?.token;
  const user = loginBody.data?.user;
  if (!token || !user) {
    throw new Error(
      `registerVerifiedOrg: step 3 (login) succeeded for ${email} but the response did not match ` +
        `{ data: { token, user } }. Got: ${JSON.stringify(loginBody)}`,
    );
  }
  if (user.id !== userId || user.org_id !== orgId) {
    throw new Error(
      `registerVerifiedOrg: step 3 (login) returned a different identity than step 1 registered for ${email} — ` +
        `expected user ${userId} in org ${orgId}, got user ${user.id} in org ${user.org_id}.`,
    );
  }

  return { token, userId, orgId, email, password, name, orgName, phone, user, runStartedAt };
}
