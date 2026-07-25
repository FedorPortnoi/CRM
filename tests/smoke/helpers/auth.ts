import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
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
