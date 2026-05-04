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
});
