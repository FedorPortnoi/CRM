import { request } from "@playwright/test";
import * as fs from "fs";
import { AUTH_STATE_PATH } from "./auth";

process.env.SMSRU_API_ID = process.env.SMSRU_API_ID ?? "test-smsru-api-id";
process.env.SMSRU_SEND_ENABLED = process.env.SMSRU_SEND_ENABLED ?? "false";

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

    const body = await res.json();
    const { token, user } = body.data;

    fs.writeFileSync(
      AUTH_STATE_PATH,
      JSON.stringify({
        token,
        userId: user.id,
        orgId: user.org_id,
        email,
        runStartedAt,
      }),
      "utf-8",
    );
  } finally {
    await api.dispose();
  }
}
