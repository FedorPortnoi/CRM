import { defineConfig } from '@playwright/test';
import { getSmokeDatabaseUrl, getSmokeDirectUrl } from './tests/smoke/helpers/database';

const SMOKE_BASE_URL = (process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const smokeDatabaseUrl = getSmokeDatabaseUrl();
const smokeDirectUrl = getSmokeDirectUrl(smokeDatabaseUrl);
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === 'true';

const webServerEnv: Record<string, string> = {
  NODE_ENV: 'test',
  CRM_SKIP_LOCAL_ENV: 'true',
  DATABASE_URL: smokeDatabaseUrl,
  DIRECT_URL: smokeDirectUrl,
  JWT_SECRET: process.env.SMOKE_JWT_SECRET ?? 'smoke-test-secret-for-local-ci-only-xxxxxx',
  SMSRU_API_ID: 'test-smsru-api-id',
  SMSRU_SEND_ENABLED: 'false',
  RESEND_API_KEY: '',
};

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 30000,
  reporter: 'list',
  workers: 1,
  globalSetup: './tests/smoke/helpers/global-setup',
  globalTeardown: './tests/smoke/helpers/global-teardown',
  use: {
    baseURL: SMOKE_BASE_URL,
  },
  webServer: {
    command: 'npm run backend:dev',
    url: `${SMOKE_BASE_URL}/health`,
    reuseExistingServer,
    env: webServerEnv,
  },
});
