import { defineConfig, configDefaults } from 'vitest/config';

// Without this file vitest falls back to its default `include`, which matches
// **/*.spec.ts and therefore swallows tests/smoke/ — a Playwright suite. Every
// one of those files then fails at collection with "Playwright Test did not
// expect test() to be called here", so a bare `npm test` reports 40 failures
// that have nothing to do with the code under test.
//
// tests/smoke/ needs a live server and is driven by playwright.config.ts at the
// repo root. Run it with `npm run test:smoke`, not through vitest.
//
// workers/ is excluded for the same reason 95cd09b keeps it out of the root
// typecheck: workers/openai-proxy has its own vitest config and runs on
// @cloudflare/vitest-pool-workers, so the root runner cannot load it and
// reports "No test suite found". Run it with:
//   cd workers/openai-proxy && npm test
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/smoke/**', 'workers/**'],
  },
});
