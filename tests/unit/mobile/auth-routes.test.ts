import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isUnauthenticatedRoute } from '../../../src/utils/authRoutes';

describe('unauthenticated navigation policy', () => {
  it.each([
    '/',
    '/login',
    '/i',
    '/invite',
    '/language-select',
    '/verify',
    '/verify-totp',
    '/forgot-password',
  ])('keeps %s reachable without a token', (pathname) => {
    expect(isUnauthenticatedRoute(pathname)).toBe(true);
  });

  it.each(['/(tabs)', '/settings/team', '/contacts', '/set-password'])(
    'still protects %s',
    (pathname) => {
      expect(isUnauthenticatedRoute(pathname)).toBe(false);
    },
  );

  it('routes a first-time language choice into the invite-first flow', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/language-select.tsx'),
      'utf8',
    );

    expect(source).toContain("router.replace('/invite')");
    expect(source).not.toContain("router.replace('/login')");
  });

  it('wires the shared policy into the root navigation guard', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/_layout.tsx'),
      'utf8',
    );

    expect(source).toContain('isUnauthenticatedRoute(pathname)');
  });
});

/**
 * The boot gate must tell "the server says this account is gone" (401) apart
 * from "the server could not be asked" (offline/timeout/5xx). When both
 * collapsed into one null, a device that never logged out of a since-deleted
 * account kept booting into /(tabs) as that ghost off the SecureStore snapshot,
 * with every API call inside answering 401 forever.
 */
describe('boot-gate dead-session sweep', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/app/index.tsx'), 'utf8');

  it('treats only 401 as a definitive rejection', () => {
    expect(source).toContain("if (response.status === 401)");
    expect(source).toContain("{ kind: 'unauthenticated' }");
    // Anything else non-ok stays a soft failure that falls back to the cache.
    expect(source).toContain("{ kind: 'unknown' }");
  });

  it('sweeps a dead session through the shared logout teardown to /login', () => {
    const branchStart = source.indexOf("fresh.kind === 'unauthenticated'");
    expect(branchStart).toBeGreaterThan(-1);
    const branch = source.slice(branchStart, source.indexOf('return;', branchStart));

    expect(branch).toContain('useUserStore.getState().logout()');
    expect(branch).toContain("router.replace('/login'");
  });

  /**
   * AppIndex's check alone is NOT enough: the root layout's onboarding
   * redirect fires synchronously off the cached snapshot and unmounts
   * AppIndex before its network check answers, so the sweep must also run
   * from the layout — the one component navigation can never unmount.
   */
  it('runs the sweep from the root layout too, where no redirect can kill it', () => {
    const layout = readFileSync(resolve(process.cwd(), 'src/app/_layout.tsx'), 'utf8');
    const sweepStart = layout.indexOf('sessionSweepRef');
    expect(sweepStart).toBeGreaterThan(-1);
    const sweep = layout.slice(sweepStart);

    expect(sweep).toContain('response.status === 401');
    expect(sweep).toContain('useUserStore.getState().logout()');
    expect(sweep).toContain("router.replace('/login')");
  });
});
