import { request } from "@playwright/test";
import * as fs from "fs";
import { AUTH_STATE_PATH, verifyRegisteredSmokeUser } from "./auth";

type RegisterResponse = {
  data?: {
    user_id?: string;
    email?: string;
    needs_verification?: boolean;
  };
};

type LoginResponse = {
  data?: {
    token?: string;
    user?: {
      id?: string;
      org_id?: string;
    };
  };
};

export default async function globalSetup() {
  fs.rmSync(AUTH_STATE_PATH, { force: true });

  const runStartedAt = new Date(Date.now() - 60_000).toISOString();
  const baseURL = (
    process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000"
  ).replace(/\/+$/, "");
  const api = await request.newContext({ baseURL });

  const email = `smoke-${Date.now()}@test.com`;
  const password = "SmokeTest123!";

  try {
    const res = await api.post("/api/v1/auth/", {
      data: { email, password, name: "Smoke Test", org_name: "Smoke Org", phone: "+70000000000" },
    });

    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`Register failed (${res.status()}): ${body}`);
    }

    const registerBody = await res.json() as RegisterResponse;
    const userId = registerBody.data?.user_id;
    if (!userId || registerBody.data?.email !== email || registerBody.data.needs_verification !== true) {
      throw new Error("Register response did not match the OTP verification contract.");
    }

    const { orgId } = await verifyRegisteredSmokeUser({ userId, email, runStartedAt });

    const loginRes = await api.post("/api/v1/auth/login", {
      data: { email, password },
    });
    if (!loginRes.ok()) {
      const body = await loginRes.text();
      throw new Error(`Login after smoke verification failed (${loginRes.status()}): ${body}`);
    }

    const loginBody = await loginRes.json() as LoginResponse;
    const token = loginBody.data?.token;
    const user = loginBody.data?.user;
    if (!token || user?.id !== userId || user.org_id !== orgId) {
      throw new Error("Login response did not match the newly verified smoke user.");
    }

    fs.writeFileSync(
      AUTH_STATE_PATH,
      JSON.stringify({
        token,
        userId,
        orgId,
        email,
        runStartedAt,
      }),
      "utf-8",
    );
  } finally {
    await api.dispose();
  }
}
