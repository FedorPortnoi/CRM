/**
 * Routes that must remain reachable before a session exists.
 *
 * Keep this policy outside RootLayout so the startup redirect can be tested
 * without mounting the native notification/router tree. `/` is deliberately
 * public: AppIndex owns the initial language/session decision and, for a new
 * unauthenticated install, sends the user to the invite-first entry screen.
 */
export const UNAUTHENTICATED_ROUTES = new Set([
  '/',
  '/login',
  '/i',
  '/invite',
  '/language-select',
  '/verify',
  '/verify-totp',
  '/forgot-password',
]);

export function isUnauthenticatedRoute(pathname: string): boolean {
  return UNAUTHENTICATED_ROUTES.has(pathname);
}
