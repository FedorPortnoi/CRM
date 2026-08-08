/**
 * route-gates.ts
 *
 * The enumerable table api/authenticate.ts has pointed at in a comment for a
 * while without it existing.
 *
 * ─── THE CLASS OF BUG THIS EXISTS TO END ────────────────────────────────────
 *
 * `adminRoutePolicy()` decides read authorization by matching the request PATH
 * against an ordered chain of literals and one-segment regexes. Two properties
 * make that fail open BY OMISSION:
 *
 *   • A route the chain does not anticipate requires no capability at all —
 *     `adminRoutePolicy` returning null means "nothing needed", not "deny".
 *   • THE URL IS NOT THE AUTHORITY ON WHAT A HANDLER READS. Every instance found
 *     so far proves it: `/contacts/:id/deals` returned full deal rows from a
 *     path the `/deals` clauses could not match; `/api/v1/calendar` hands back
 *     `deal: { id, title }` and the `deal_id` scalar; `/api/v1/tasks` hands back
 *     `deal_id` on every row. None of them contains `/deals` where the chain was
 *     looking, and each was found separately, by hand, after shipping.
 *
 * ─── WHAT THIS TABLE IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────
 *
 * It is a declaration, keyed by the FASTIFY ROUTE PATTERN rather than by a
 * concrete URL, of the routes that read deal data and what each one requires.
 * The pattern is what Fastify actually matched (`request.routeOptions.url`), so
 * it cannot be dodged by percent-encoding and it cannot drift from the
 * registration the way a hand-written regex can.
 *
 * It is NOT a complete inventory of every route in the API, and it must not be
 * described as one. A table that claims to be authoritative while dozens of
 * routes enforce their own gates inside their controllers — requireWebhookAdmin
 * on the ten webhook routes, the deals.read check in controllers/attachments.ts,
 * the field-level omission in controllers/sync.ts — would be a lie that the next
 * reader trusts over the code. Scoped honestly to one surface, it is true.
 *
 * It is also NOT an override. The lookup in authenticate.ts is CONJUNCTIVE: this
 * table can only ADD a requirement to what the existing chain already demands,
 * never remove one. A table introduced to stop fail-open must not become the
 * fastest way to fail open, and "someone adds an UNGATED row" must not be able
 * to delete a live gate.
 *
 * ─── HEAD ───────────────────────────────────────────────────────────────────
 *
 * Fastify auto-registers a HEAD twin for every GET (exposeHeadRoutes defaults
 * true) and that twin runs the SAME handler. HEAD is therefore NORMALIZED onto
 * its GET row here rather than being separately declarable: a human who fills in
 * the GET row and forgets the HEAD one would recreate exactly the blind spot the
 * `method === 'GET'` → `isReadOnlyMethod` sweep removed.
 */

import type { Capability } from '../services/capabilities';

/**
 * Every route that returns deal data, and the capability it requires.
 *
 * A route may appear here with a capability (the whole route is refused without
 * it) or as FIELD_LEVEL (the route is open, but the deal data inside it is
 * withheld by the controller from a caller without `deals.read`). The second
 * kind is declared rather than omitted precisely because omission is the bug:
 * "this route touches deals and here is how it is handled" is the statement, and
 * the drift test below is what keeps the statement true.
 */
export const FIELD_LEVEL = 'field-level' as const;

export type DealRouteGate = Capability | typeof FIELD_LEVEL;

export const DEAL_READ_ROUTES: Readonly<Record<string, DealRouteGate>> = Object.freeze({
  // Whole-route refusal. Mirrors the deals.read clause in adminRoutePolicy; the
  // two agreeing is asserted by tests/unit/backend/route-gate-declarations.test.ts.
  'GET /api/v1/deals': 'deals.read',
  // Fastify registers a trailing-slash HEAD twin for the root route of a
  // prefixed plugin, and `routeOptions.url` carries the slash. adminRoutePolicy
  // strips it (apiPath) so the chain already covers it; declared anyway, because
  // a table that silently omits a registered pattern is the failure this file
  // exists to prevent.
  'GET /api/v1/deals/': 'deals.read',
  'GET /api/v1/deals/:id': 'deals.read',
  'GET /api/v1/deals/pipelines': 'deals.read',
  'GET /api/v1/deals/stages/library': 'deals.read',
  'GET /api/v1/contacts/:id/deals': 'deals.read',
  // Renders the whole pipeline as a PDF. Already covered by the data.export
  // branch of the chain — a stronger gate than deals.read — and declared here so
  // the drift guard sees it.
  'GET /api/v1/export/deals/pdf': 'data.export',

  // Field-level. Refusing these routes outright would break work that the roles
  // without deals.read legitimately do — `support` has a calendar and tasks like
  // everyone else — so the controller withholds the deal fields instead.
  'GET /api/v1/calendar': FIELD_LEVEL,
  'GET /api/v1/calendar/:id': FIELD_LEVEL,
  'POST /api/v1/calendar': FIELD_LEVEL,
  'PATCH /api/v1/calendar/:id': FIELD_LEVEL,
  'GET /api/v1/tasks': FIELD_LEVEL,
  'GET /api/v1/sync/delta': FIELD_LEVEL,
  'GET /api/v1/attachments': FIELD_LEVEL,
});

/** Normalizes HEAD onto GET. See the note in the file header. */
export function routeGateKey(method: string, routePattern: string): string {
  const upper = method.toUpperCase();
  return `${upper === 'HEAD' ? 'GET' : upper} ${routePattern}`;
}

/**
 * The capability this route requires by declaration, or undefined.
 *
 * `undefined` for an unknown route means "this table has nothing to say", NOT
 * "allowed" — the caller still runs the ordinary chain. See the conjunctive note
 * in the header.
 */
export function declaredRouteCapability(
  method: string,
  routePattern: string | undefined,
): Capability | undefined {
  if (!routePattern) return undefined;
  const declared = DEAL_READ_ROUTES[routeGateKey(method, routePattern)];
  return declared === undefined || declared === FIELD_LEVEL ? undefined : declared;
}

/**
 * Does a route pattern look like it serves deals?
 *
 * Used only by the drift test, which asserts that every registered route whose
 * pattern contains a `deals` segment is declared above. That is the mechanical
 * guard: the day someone adds `f.get('/:id/history')` to routes/deals.ts, the
 * build goes red naming the route instead of the route silently shipping
 * ungated, which is the exact failure this whole file is about.
 */
export function looksLikeDealRoute(routePattern: string): boolean {
  return routePattern.split('/').includes('deals');
}
