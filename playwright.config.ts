import { defineConfig } from '@playwright/test';

const SMOKE_BASE_URL = (process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const smokeDatabaseUrl = process.env.SMOKE_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const allowNonTestDb = process.env.PLAYWRIGHT_ALLOW_NON_TEST_DB === 'true';
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === 'true';

function isLocalDatabaseHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function assertSafeSmokeDatabase(databaseUrl?: string): void {
  if (!databaseUrl || allowNonTestDb) return;

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Smoke tests received an invalid DATABASE_URL.');
  }

  const databaseName = parsed.pathname.replace(/^\/+/, '');
  const looksLikeTestDb = /(test|smoke)/i.test(databaseName);
  if (looksLikeTestDb || isLocalDatabaseHost(parsed.hostname)) return;

  throw new Error(
    'Refusing to run smoke tests against a non-local database that is not named like a test DB. ' +
      'Set SMOKE_DATABASE_URL/TEST_DATABASE_URL to a test database, or set PLAYWRIGHT_ALLOW_NON_TEST_DB=true intentionally.',
  );
}

assertSafeSmokeDatabase(smokeDatabaseUrl);

if (reuseExistingServer && !allowNonTestDb && !process.env.SMOKE_DATABASE_URL && !process.env.TEST_DATABASE_URL) {
  throw new Error(
    'PLAYWRIGHT_REUSE_SERVER=true requires SMOKE_DATABASE_URL or TEST_DATABASE_URL so the reused server database is explicit.',
  );
}

const webServerEnv: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET: process.env.JWT_SECRET ?? 'smoke-test-secret-for-local-ci-only-xxxxxx',
  SMSRU_API_ID: process.env.SMSRU_API_ID ?? 'test-smsru-api-id',
  SMSRU_SEND_ENABLED: process.env.SMSRU_SEND_ENABLED ?? 'false',
};

if (smokeDatabaseUrl) {
  webServerEnv.DATABASE_URL = smokeDatabaseUrl;
}

if (process.env.SMOKE_DIRECT_URL ?? process.env.TEST_DIRECT_URL ?? process.env.DIRECT_URL) {
  webServerEnv.DIRECT_URL = process.env.SMOKE_DIRECT_URL ?? process.env.TEST_DIRECT_URL ?? process.env.DIRECT_URL ?? '';
}

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
