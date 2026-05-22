import * as fs from "fs";
import * as path from "path";

interface AuthState {
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
