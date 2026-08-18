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
