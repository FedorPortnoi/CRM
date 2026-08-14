import { FastifyReply, FastifyRequest } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthController } from '../controllers/auth';
import { InviteController } from '../controllers/invites';
import { ASSIGNABLE_ROLE_VALUES } from '../../services/capabilities';
import { isValidTimeZone } from '../../services/reminders';
import { PostgresRateLimitStore, consumeAuthIpBudget } from '../../services/rate-limit-store';
import { isBlockedPassword } from '../../services/password-blocklist';

/**
 * The single password policy. Every path that SETS a password imports this one
 * object — register, invite-accept, set-credentials, change-password — so the
 * rules cannot drift apart between them.
 *
 * The byte cap is not cosmetic. bcrypt's Blowfish key schedule consumes exactly
 * 72 bytes and silently ignores the rest, so a `.max(100)` in CHARACTERS meant
 * two different passwords sharing a 72-byte prefix authenticated
 * interchangeably. In Russian that bites far earlier than it looks: UTF-8
 * Cyrillic is 2 bytes per character, so a passphrase was being truncated at
 * ~36 characters — well inside a plausible one, and well under the 100 the UI
 * advertised. Measured in bytes, refused rather than truncated.
 */
export const PasswordSchema = z.string()
  .min(8)
  .max(72, 'Password must be at most 72 characters')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a number')
  .regex(/[^A-Za-z0-9]/, 'Password must include a symbol')
  /**
   * Last, and it has to be: .refine()/.superRefine() return a ZodEffects, which
   * has no .regex(), so anything chained after this stops type-checking. One
   * superRefine rather than two chained refines so both messages stay
   * independent and the reason for the ordering only has to be stated once.
   *
   * THE MEMBERSHIP TEST IS THE SECOND CLAUSE, and it is the one that matters.
   * Everything above it describes a SHAPE, and both signup screens print that
   * shape to the user — so the rules were generating `Password1!` rather than
   * refusing it. The list is offline and in this repo: no HaveIBeenPwned, no
   * network call on the account-creation path. See services/password-blocklist.ts.
   *
   * Deliberately NOT applied to LoginSchema or JoinSchema below. Those read an
   * already-stored credential; putting the policy there would lock out every
   * existing user whose password is on the list, and this product has no
   * password-reset flow and no SMS to rescue them with.
   */
  .superRefine((v, ctx) => {
    if (Buffer.byteLength(v, 'utf8') > 72) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Password is too long (max 72 bytes; Cyrillic letters count as two)',
      });
    }

    if (isBlockedPassword(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        // Russian, not English. A shipped 1.1.6 binary has no client-side
        // "common password" branch, so it will render whatever the server says
        // verbatim inside a Russian UI — which is the exact regression c6f959f
        // was written to remove.
        message: 'Этот пароль слишком простой — придумайте другой',
      });
    }
  });

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: PasswordSchema,
  name: z.string().min(1).max(100),
  org_name: z.string().min(1).max(200),
  phone: z.string().min(10).max(20),
});

const VerifyOtpSchema = z.object({
  user_id: z.string().uuid(),
  code: z.string().length(6).regex(/^\d{6}$/),
});

const ResendVerificationSchema = z.object({
  user_id: z.string().uuid(),
});

const ForgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

const ResetPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().length(6).regex(/^\d{6}$/),
  // The SAME object every other password setter uses, so the 72-byte cap, the
  // four character classes and the blocklist cannot fork on the one path a
  // locked-out user reaches.
  new_password: PasswordSchema,
});

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

// ── Invite links ───────────────────────────────────────────────────────────

const CreateInviteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.enum(ASSIGNABLE_ROLE_VALUES),
});

const OpenInviteSchema = z.object({
  token: z.string().min(20).max(200),
});

// Exactly one credential, never a mixture. `.refine` rather than a union so a
// caller that sends two gets a validation error instead of silently having the
// first branch win — a request carrying two is a client bug worth surfacing,
// not something to guess at.
const LookupInviteSchema = z
  .object({
    token: z.string().min(20).max(200).optional(),
    handoff: z.string().min(10).max(200).optional(),
    claim_code: z.string().min(4).max(16).optional(),
  })
  .refine(
    (b) => [b.token, b.handoff, b.claim_code].filter(Boolean).length === 1,
    { message: 'Supply exactly one of token, handoff or claim_code' },
  );

const AcceptInviteSchema = z.object({
  accept_token: z.string().min(10).max(200),
  // Required by product decision. It cannot be verified — this deployment has no
  // SMS provider at all — so `phone_verified` stays false and this is contact
  // information, never a factor.
  phone: z.string().trim().min(10).max(20),
  email: z.string().trim().toLowerCase().email(),
  password: PasswordSchema,
});

const JoinSchema = z.object({
  company_code: z.string().trim().min(1).max(64),
  username: z.string().trim().min(1).max(201),
  password: z.string().min(1),
});

const InviteSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  role: z.enum(ASSIGNABLE_ROLE_VALUES),
});

const SetCredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  new_password: PasswordSchema,
});

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1).max(100),
  new_password: PasswordSchema,
});

const SetManagerSchema = z.object({
  manager_id: z.string().uuid().nullable(),
});

const SessionPreferenceSchema = z.object({
  stay_signed_in: z.boolean(),
});

const SetTimezoneSchema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, 'timezone must be a valid IANA zone name'),
});

const OnboardingSchema = z.object({
  completed: z.boolean().default(false),
  dismissed_steps: z.array(z.string().max(100)).max(20).optional(),
});

const AuditQuerySchema = z.object({
  action: z.string().trim().min(1).max(100).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  user_id: z.string().uuid().optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The per-route budgets on the eight unauthenticated routes below.
 *
 * `store` is the whole point of this helper. Without it the plugin falls through
 * to its in-process LruMap, and "5 attempts per 15 minutes" quietly means "…or
 * per restart, whichever comes first" — plus the LRU evicts at 5000 entries per
 * route, so a blocked key can be flushed out without any restart at all. See
 * services/rate-limit-store.ts for the full argument and for why only these
 * eight routes are backed by Postgres.
 *
 * IT ONLY DOES ANYTHING BECAUSE OF HybridRateLimitStore. @fastify/rate-limit
 * reads `store` once, from the PLUGIN registration in backend/index.ts, and per
 * route calls `store.child(mergedParams)` — LocalStore's child() discards
 * `params.store`, so for as long as the plugin was registered without a store
 * this line was dead config that read exactly like the fix. HybridRateLimitStore
 * is a child() that honours it. The two must stay wired together: delete the
 * `store:` in backend/index.ts and every budget below silently goes back to
 * being per-process. tests/unit/backend/rate-limit-store.test.ts pins it.
 *
 * `skipOnError` is deliberately absent and must stay absent: it defaults to
 * false, which is what makes a store failure refuse the request instead of
 * waving it through. `continueExceeding`, `exponentialBackoff` and `ban` are
 * absent for the opposite reason — each lets one abusive client extend or
 * escalate a penalty on a key that legitimate CGNAT users share.
 *
 * `env` is a parameter for the same recorded reason as getAuthIpBudget(): the
 * ceiling is raised under NODE_ENV==='test' so unrelated suites are not throttled,
 * and a test that can only ever see that substitute passes with the real ceiling
 * deleted.
 */
export function authRouteMax(max: number, env: NodeJS.ProcessEnv = process.env): number {
  return env.NODE_ENV === 'test' ? 10_000 : max;
}

function authRateLimit(max: number, timeWindow: string, includeEmail = false) {
  return {
    max: authRouteMax(max),
    timeWindow,
    hook: 'preHandler' as const,
    store: PostgresRateLimitStore,
    keyGenerator: (request: FastifyRequest): string => {
      if (!includeEmail) {
        return request.ip;
      }

      const body = request.body as { email?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : 'unknown';
      return `${request.ip}:${email}`;
    },
  };
}

/**
 * A per-IP ceiling across ALL the sensitive auth routes, spent before their own
 * per-key budgets.
 *
 * This is not decoration on top of the limits above — until it existed there was
 * no per-IP ceiling on these routes whatsoever. @fastify/rate-limit treats a
 * route-level `config.rateLimit` as a REPLACEMENT for the global limiter rather
 * than as an addition to it (index.js:144-155), so every route carrying
 * authRateLimit() was exempt from the 100 req/min global cap in backend/index.ts.
 * On POST /login the key is `<ip>:<email>`, so varying the address minted an
 * unlimited number of fresh buckets from one host: unbounded password spraying,
 * and — at one bcrypt-cost-12 compare per request on a single pm2 fork —
 * an unauthenticated denial of service against the whole product.
 *
 * It has to be hand-written. A second `config.rateLimit` on the same route
 * cannot work: the plugin sets a `rateLimitRan` flag on the request (index.js:281)
 * and every later hook of its own returns immediately.
 *
 * Declared as `preHandler`, matching `hook: 'preHandler'` above, so a request
 * that fails schema validation still gets its 400 without spending budget. The
 * plugin appends its own hook after this one, so the cheap shared ceiling is
 * charged first.
 */
export async function enforceAuthIpFloor(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  // Throws RateLimitStoreError if the store is unreachable; backend/index.ts
  // turns that into a 503. It must never become a silent pass.
  const verdict = await consumeAuthIpBudget(request.ip);
  if (verdict.allowed) {
    return;
  }

  // Logged with the address because the one thing that can go wrong here is a
  // false positive against a carrier CGNAT or an office NAT, and that is only
  // fixable if it is visible. AUTH_IP_RATE_LIMIT_MAX raises the ceiling without
  // a redeploy.
  request.log.warn(
    { ip: request.ip, url: request.url },
    '[rate-limit] per-IP auth floor refused a request',
  );

  return reply
    .header('retry-after', String(verdict.retryAfterSec))
    .status(429)
    .send({
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
    });
}

const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post('/', {
    config: { rateLimit: authRateLimit(5, '15 minutes') },
    preHandler: enforceAuthIpFloor,
    schema: { body: RegisterSchema },
  }, AuthController.register);
  fastify.post('/login', {
    config: { rateLimit: authRateLimit(5, '15 minutes', true) },
    preHandler: enforceAuthIpFloor,
    schema: { body: LoginSchema },
  }, AuthController.login);
  fastify.post('/join', {
    config: { rateLimit: authRateLimit(5, '15 minutes') },
    preHandler: enforceAuthIpFloor,
    schema: { body: JoinSchema },
  }, AuthController.join);
  /**
   * Password recovery. Both public — the person using them cannot sign in, which
   * is the whole point — and both carrying the same two layers of limiting as
   * every other public auth route: a per-(ip,email) budget on the durable store
   * and the shared per-IP floor underneath it. `includeEmail` is true so a spray
   * across many addresses from one host does not share one bucket.
   *
   * Both must also be in isPublicApiRoute() (api/authenticate.ts) or the global
   * preHandler 401s them before the handler runs and the feature is dead on
   * arrival.
   */
  fastify.post('/forgot-password', {
    config: { rateLimit: authRateLimit(3, '15 minutes', true) },
    preHandler: enforceAuthIpFloor,
    schema: { body: ForgotPasswordSchema },
  }, AuthController.forgotPassword);
  fastify.post('/reset-password', {
    config: { rateLimit: authRateLimit(5, '15 minutes', true) },
    preHandler: enforceAuthIpFloor,
    schema: { body: ResetPasswordSchema },
  }, AuthController.resetPassword);
  fastify.post('/logout', AuthController.logout);
  fastify.post('/logout-all', AuthController.logoutAll);
  fastify.get('/sessions', AuthController.listSessions);
  fastify.get('/audit', {
    schema: { querystring: AuditQuerySchema },
  }, AuthController.listAuditEvents);
  fastify.get('/users', AuthController.listUsers);
  fastify.post('/users/invite', {
    schema: { body: InviteSchema },
  }, AuthController.inviteUser);
  fastify.patch('/users/:id/deactivate', AuthController.deactivateUser);
  fastify.patch('/users/:id/role', {
    schema: { body: z.object({ role: z.enum(ASSIGNABLE_ROLE_VALUES) }) },
  }, AuthController.changeUserRole);
  fastify.patch('/users/:id/manager', {
    schema: { body: SetManagerSchema },
  }, AuthController.setUserManager);
  // ── Invite links ─────────────────────────────────────────────────────────
  // The three redemption routes are public (see isPublicApiRoute) and rate
  // limited hard: each one accepts a secret, so each one is a guessing surface.
  // The claim code is only six characters, which is what sets the budget here —
  // the 32-byte link token would tolerate far more.
  fastify.post('/invites', {
    schema: { body: CreateInviteSchema },
  }, InviteController.create);
  fastify.get('/invites', InviteController.list);
  fastify.delete('/invites/:id', {
    schema: { params: z.object({ id: z.string().uuid() }) },
  }, InviteController.revoke);

  fastify.post('/invites/open', {
    config: { rateLimit: authRateLimit(20, '15 minutes') },
    preHandler: enforceAuthIpFloor,
    schema: { body: OpenInviteSchema },
  }, InviteController.open);
  fastify.post('/invites/lookup', {
    config: { rateLimit: authRateLimit(20, '15 minutes') },
    preHandler: enforceAuthIpFloor,
    schema: { body: LookupInviteSchema },
  }, InviteController.lookup);
  fastify.post('/invites/accept', {
    config: { rateLimit: authRateLimit(10, '15 minutes') },
    preHandler: enforceAuthIpFloor,
    schema: { body: AcceptInviteSchema },
  }, InviteController.accept);

  fastify.get('/company-code', AuthController.getCompanyCode);
  fastify.post('/company-code/rotate', AuthController.rotateCompanyCode);
  fastify.patch('/me/password', {
    schema: { body: ChangePasswordSchema },
  }, AuthController.changePassword);
  fastify.patch('/me/credentials', {
    schema: { body: SetCredentialsSchema },
  }, AuthController.setCredentials);
  fastify.patch('/me/timezone', {
    schema: { body: SetTimezoneSchema },
  }, AuthController.setTimezone);
  fastify.patch('/me/session-preference', {
    schema: { body: SessionPreferenceSchema },
  }, AuthController.setSessionPreference);
  fastify.post('/verify', {
    config: { rateLimit: authRateLimit(10, '15 minutes') },
    preHandler: enforceAuthIpFloor,
    schema: { body: VerifyOtpSchema },
  }, AuthController.verifyOtp);
  fastify.post('/verify/resend', {
    config: { rateLimit: authRateLimit(3, '5 minutes') },
    preHandler: enforceAuthIpFloor,
    schema: { body: ResendVerificationSchema },
  }, AuthController.resendVerification);
};

export default authRoutes;
