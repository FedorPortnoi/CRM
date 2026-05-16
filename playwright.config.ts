import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 10000,
  reporter: 'list',
  workers: 1,
  globalSetup: './tests/smoke/helpers/global-setup',
  use: {
    baseURL: 'http://localhost:3000',
  },
  webServer: {
    command: 'npm run backend:dev',
    url: 'http://localhost:3000/health',
    reuseExistingServer: true,
    env: { NODE_ENV: 'test' },
  },
});
