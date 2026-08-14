import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { db } from '../../services/db';
import { auditLog } from '../../services/audit';
import { assignableRoles, isRole } from '../../services/capabilities';
import { signSessionToken, uniqueUsernameForOrg, normalizeEmail } from './auth';
import { issueCode } from '../../services/verification';
import { sendEmail, isEmailSendingEnabled } from '../../services/email';
import { isEmailVerificationEnforced } from '../../config/security';
import {
  ACCEPT_TTL_MS,
  CLAIM_TTL_MS,
  INVITE_TTL_MS,
  buildAppStoreUrl,
  buildInviteUrl,
  buildRuStoreUrl,
  generateClaimCode,
  generateHandoffToken,
  generateLinkToken,
  hashSecret,
  inviteRejection,
  normalizeClaimCode,
} from '../../services/invites';

const saltRounds = process.env.NODE_ENV === 'test' ? 4 : 12;

const INVITE_BASE_URL = process.env.INVITE_BASE_URL ?? 'https://4kub.ru';
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE ?? 'com.fedorportnoi.crm';
const IOS_ASC_APP_ID = process.env.IOS_ASC_APP_ID ?? '6776447873';

/**
 * ONE response for every failed redemption, whatever went wrong.
 *
 * A caller who can tell "expired" from "already used" from "never existed" has
 * an oracle: they can probe the endpoint to learn which tokens are real without
 * ever redeeming one. The specific reason goes to the audit log, where the owner
 * can see it and an attacker cannot.
 */
function inviteUnavailable(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: 'INVITE_UNAVAILABLE',
      message: 'Приглашение недействительно или уже использовано',
    },
  });
}

/**
 * Prisma's unique-constraint violation.
 *
 * Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError`: the
 * only thing this needs from the error is its code, and matching on shape keeps
 * the check working when the error has crossed a client boundary.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/**
 * How many times `open` will draw a fresh claim code before giving up.
 *
 * claim_hash is UNIQUE now (see schema.prisma), which is what makes the
 * unauthenticated claim-code lookup single-tenant — but a constraint that is
 * enforced is a constraint that can be HIT. Six characters over a 32-symbol
 * alphabet is 2^30, and while the migration clears dead digests, the live ones
 * still collide with probability (live codes)/2^30 per mint. That is rare enough
 * never to appear in testing and common enough to eventually hand a real invitee
 * a 500 on the one screen they cannot route around.
 *
 * The collision is with a random digest, so a redraw is independent: three
 * attempts drive the residual chance to (live/2^30)³, which is past the point
 * where it is worth writing more code. Failing after that is correct — a
 * constraint violation that survives three independent draws is not a collision,
 * it is a bug, and it should surface as one.
 */
const CLAIM_CODE_MINT_ATTEMPTS = 3;

export const InviteController = {
  // ─── Owner side ───────────────────────────────────────────────────────────

  create: async (request: FastifyRequest, reply: FastifyReply) => {
    const callerRole = request.user.role;
    const { name, role } = request.body as { name: string; role: string };

    // assignableRoles() is the same gate the old invite path uses, so "admins
    // cannot mint admins" stays expressed once in the capability map.
    const validRoles = assignableRoles(callerRole);
    if (!isRole(role) || !validRoles.includes(role)) {
      return reply.code(400).send({
        error: { code: 'INVALID_ROLE', message: `Role must be one of: ${validRoles.join(', ')}` },
      });
    }

    const trimmed = name.trim();
    if (!trimmed) {
      return reply.code(400).send({ error: { code: 'INVALID_NAME', message: 'Name is required' } });
    }

    const token = generateLinkToken();
    const invite = await db.invite.create({
      data: {
        organization_id: request.user.org_id,
        name: trimmed,
        role: role as UserRole,
        created_by: request.user.sub,
        token_hash: hashSecret(token),
        expires_at: new Date(Date.now() + INVITE_TTL_MS),
      },
      select: { id: true, name: true, role: true, expires_at: true, created_at: true },
    });

    await auditLog({
      action: 'invite.create',
      outcome: 'success',
      request,
      organizationId: request.user.org_id,
      userId: request.user.sub,
      metadata: { invite_id: invite.id, role },
    });

    // The token is returned exactly once, here. It is not stored in plaintext,
    // so this response is the only chance to put it in front of the owner.
    return reply.code(201).send({
      data: { ...invite, invite_url: buildInviteUrl(INVITE_BASE_URL, token) },
      meta: {},
    });
  },

  list: async (request: FastifyRequest, reply: FastifyReply) => {
    const invites = await db.invite.findMany({
      where: {
        organization_id: request.user.org_id,
        consumed_at: null,
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
      select: { id: true, name: true, role: true, expires_at: true, opened_at: true, created_at: true },
    });
    return reply.send({ data: invites, meta: {} });
  },

  revoke: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    // updateMany, not update: the org filter has to be part of the WHERE so
    // another tenant's invite id resolves to "nothing changed" rather than to a
    // successful cross-org write.
    const { count } = await db.invite.updateMany({
      where: { id, organization_id: request.user.org_id, consumed_at: null },
      data: { revoked_at: new Date() },
    });

    if (count === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Приглашение не найдено' } });
    }

    await auditLog({
      action: 'invite.revoke',
      outcome: 'success',
      request,
      organizationId: request.user.org_id,
      userId: request.user.sub,
      metadata: { invite_id: id },
    });

    return reply.send({ data: { revoked: true }, meta: {} });
  },

  // ─── Landing page (public) ────────────────────────────────────────────────

  /**
   * The web page at /i has read the token out of the URL fragment and POSTs it
   * here. Mints the handoff + claim pair and returns the store links.
   *
   * Neither secret it returns can create an account: both are only redeemable at
   * `lookup`, which is what mints the separate accept token.
   */
  open: async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    const token = String(body.token ?? '');

    const invite = await db.invite.findUnique({
      where: { token_hash: hashSecret(token) },
      select: {
        id: true, name: true, role: true, expires_at: true, consumed_at: true,
        revoked_at: true, opened_at: true, organization_id: true,
        organization: { select: { name: true } },
      },
    });

    if (!invite) return inviteUnavailable(reply);

    const rejection = inviteRejection(invite);
    if (rejection) {
      await auditLog({
        action: 'invite.open', outcome: 'denied', request,
        organizationId: invite.organization_id,
        metadata: { invite_id: invite.id, reason: rejection },
      });
      return inviteUnavailable(reply);
    }

    const now = new Date();

    // Draw, write, and draw again if the database says the code is taken.
    //
    // claim_hash is UNIQUE, and it has to be: the claim-code lookup is
    // unauthenticated and so has nothing but the six characters to pick a tenant
    // with. The price is that this write can now fail on a collision, and the
    // one thing that must not happen on the invitee's first screen is a 500 they
    // cannot retry past. So the collision is handled where it occurs rather than
    // being argued away — the same move `lookup` makes on the read side.
    let handoff = '';
    let claimCode = '';
    for (let attempt = 1; ; attempt += 1) {
      handoff = generateHandoffToken();
      claimCode = generateClaimCode();
      try {
        await db.invite.update({
          where: { id: invite.id },
          data: {
            handoff_hash: hashSecret(handoff),
            claim_hash: hashSecret(claimCode),
            claim_expires_at: new Date(now.getTime() + CLAIM_TTL_MS),
            opened_at: invite.opened_at ?? now,
          },
        });
        break;
      } catch (error) {
        // Only a uniqueness collision is retryable, and only so many times.
        // Anything else — a vanished row, a dead connection — is rethrown
        // untouched, because a redraw cannot fix it and swallowing it here would
        // turn a real fault into a mysteriously slow request.
        if (attempt >= CLAIM_CODE_MINT_ATTEMPTS || !isUniqueViolation(error)) throw error;
      }
    }

    // Org-scoped, and every open is recorded — not just the first. Repeated opens
    // are the signal of a link forwarded into a group chat, and `open` hands any
    // holder the invitee's name, the organisation name and the assigned role. The
    // owner cannot react to what they cannot see.
    await auditLog({
      action: 'invite.open', outcome: 'success', request,
      organizationId: invite.organization_id,
      metadata: { invite_id: invite.id, repeat_open: invite.opened_at !== null },
    });

    return reply.send({
      data: {
        name: invite.name,
        role: invite.role,
        org_name: invite.organization.name,
        claim_code: claimCode,
        // The handoff rides the install: as ?referrerId= on Android, through the
        // clipboard on iOS.
        store: {
          android: buildRuStoreUrl(ANDROID_PACKAGE, handoff),
          ios: buildAppStoreUrl(IOS_ASC_APP_ID),
        },
        handoff,
      },
      meta: {},
    });
  },

  // ─── App side (public) ────────────────────────────────────────────────────

  /**
   * The app asking "is there an invite for me?", by whichever route survived the
   * install. Tried in order of reliability by the client; this handler accepts
   * any one of them.
   */
  lookup: async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    const now = new Date();

    const select = {
      id: true, name: true, role: true, expires_at: true, consumed_at: true, revoked_at: true,
      claim_expires_at: true, organization_id: true,
      // Read, never returned. It is the compare-and-swap discriminator for the
      // recovery re-mint below: rotating the accept token is only safe if the
      // rotation is conditional on the exact token being replaced.
      accept_hash: true,
      organization: { select: { name: true } },
    } as const;

    type LookupRow = {
      id: string;
      name: string;
      role: UserRole;
      expires_at: Date;
      consumed_at: Date | null;
      revoked_at: Date | null;
      claim_expires_at: Date | null;
      organization_id: string;
      accept_hash: string | null;
      organization: { name: string };
    };

    let invite: LookupRow | null = null;
    let via = '';

    if (typeof body.token === 'string' && body.token) {
      // Universal Link / App Link: the app was opened by the link itself.
      invite = await db.invite.findUnique({ where: { token_hash: hashSecret(body.token) }, select });
      via = 'link';
    } else if (typeof body.handoff === 'string' && body.handoff) {
      // RuStore install referrer, or the iOS clipboard.
      invite = await db.invite.findUnique({ where: { handoff_hash: hashSecret(body.handoff) }, select });
      via = 'handoff';
    } else if (typeof body.claim_code === 'string' && body.claim_code) {
      const code = normalizeClaimCode(body.claim_code);

      // findMany(take: 2), not findFirst — the difference is the whole point.
      //
      // Every other branch here resolves a full-entropy secret through a UNIQUE
      // column, so "one credential, one invite" is a database guarantee. This
      // branch resolves six characters, and it is the ONLY branch with no
      // organization_id available to narrow on, because the endpoint is
      // unauthenticated: whatever this query matches, the caller is told which
      // company they are joining and handed a token to join it.
      //
      // `findFirst` over a non-unique column turned that into "no two live claim
      // codes are ever equal, anywhere in the product" — an assumption, stated
      // nowhere, about 2^30 values shared across every tenant. And its failure
      // was silent and maximally bad: Postgres returns whichever row it reached
      // first, so a collision does not error, it enrols the invitee in a company
      // that never invited them, at whatever role that company chose.
      //
      // This file has retracted this exact reasoning shape once already — see
      // services/invites.ts:41-50, where device-fingerprint recovery was removed
      // because its "only match if exactly one candidate" guard sat on top of a
      // discriminator that did not discriminate in production. The difference
      // here is which part is doing the work: the discriminator is a real
      // secret, and "exactly one candidate" is the CHECK on it, not a substitute
      // for it. Two rows means refuse. It never means choose.
      //
      // schema.prisma now carries @unique on claim_hash, so the database cannot
      // hold two of these at once and this branch should be unreachable. It
      // stays because a constraint is only true where it has been applied, and
      // this code ships to every environment ahead of every migration.
      const candidates: LookupRow[] = await db.invite.findMany({
        where: {
          claim_hash: hashSecret(code),
          claim_expires_at: { gt: now },
          consumed_at: null,
          revoked_at: null,
        },
        select,
        take: 2,
      });

      if (candidates.length > 1) {
        // Audited once per organisation involved. A collision is not one
        // tenant's event: every owner whose invite was in the ambiguity had a
        // pending hire that just failed to redeem, and listAuditEvents filters
        // hard on organization_id, so a single row would be visible to at most
        // one of them.
        for (const candidate of candidates) {
          await auditLog({
            action: 'invite.lookup', outcome: 'denied', request,
            organizationId: candidate.organization_id,
            metadata: { invite_id: candidate.id, reason: 'claim_code_collision', via: 'claim_code' },
          });
        }
        // The same 404 as every other failure. The caller learns nothing — least
        // of all that they just found a code answering to two organisations.
        return inviteUnavailable(reply);
      }

      invite = candidates[0] ?? null;
      via = 'claim_code';
    } else {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'No invite credential supplied' },
      });
    }

    if (!invite) return inviteUnavailable(reply);

    const rejection = inviteRejection(invite);
    if (rejection) {
      await auditLog({
        action: 'invite.lookup', outcome: 'denied', request,
        organizationId: invite.organization_id,
        metadata: { invite_id: invite.id, reason: rejection, via },
      });
      return inviteUnavailable(reply);
    }

    // Mint the accept token into its OWN column and burn the handoff.
    //
    // This is the fix for the flaw that made the handoff a complete
    // account-creation credential: only `accept_hash` — which has never left
    // this server except in the response below — can be spent at `accept`.
    //
    // THE HANDOFF DIES HERE; THE CLAIM CODE DOES NOT. They look symmetrical and
    // they are not, because they have been to different places.
    //
    // The handoff has ridden through RuStore's query string and the iOS system
    // clipboard — somebody else's logs, and any app on the device. It must be
    // spendable exactly once.
    //
    // The claim code has only ever been on the invitee's own screen. Keeping it
    // alive until the invite is actually consumed is what makes this flow
    // RECOVERABLE: if the app is killed between lookup and submit — a phone call,
    // a backgrounded install, a dropped connection — the accept token in memory
    // is gone, and without a surviving credential the invite would be stranded
    // while the owner's list still showed it as pending. The invitee can now
    // simply retype the code. It is rate-limited and can only ever be traded for
    // a fresh accept token, never spent directly.
    //
    // The write is CONDITIONAL so two concurrent lookups cannot both mint. The
    // app deliberately tries several credentials in order of reliability, so a
    // Universal Link opening alongside a stored install referrer is an ordinary
    // race, not an edge case — and the loser must not silently invalidate the
    // accept token the winner just handed to the form.
    //
    // ─── WHY THE CLAIM CODE, AND ONLY THE CLAIM CODE, MAY MINT AGAIN ─────────
    //
    // The paragraph above described recovery for a year while delivering none of
    // it. Two guards, each reasonable alone, closed the window completely:
    // the mint refuses while an accept token is live (30 min from lookup), and
    // the claim code died 15 min from OPEN, which is always earlier than lookup.
    // Retype early and the invite still holds a live token, so the answer is
    // 409; retype late enough for that token to lapse and the code has been dead
    // for a quarter of an hour, so the answer is 404. There was no third
    // instant. The TTL half is fixed in services/invites.ts, where CLAIM_TTL is
    // now DERIVED from ACCEPT_TTL so the inequality cannot silently invert
    // again; this is the other half.
    //
    // A third branch is added to the guard, for the claim code alone: the invite
    // may mint again if the caller can name the accept token currently on it.
    // That rests on the provenance distinction this file already draws two
    // paragraphs up, extended one step:
    //
    //   • The HANDOFF has been through RuStore's query string and the iOS system
    //     clipboard. It is not evidence of anything except that somebody read a
    //     log, so it must stay spendable exactly once — and it already is, since
    //     the write below nulls it and a burned handoff resolves to no row at
    //     all. This branch cannot reach it.
    //   • The LINK is the credential most likely to have been forwarded — the
    //     landing page exists because people paste these into group chats — and
    //     it is the one the app fires automatically at launch. It is precisely
    //     the racer the conditional mint was written to stop, so it keeps the
    //     original two-branch guard and still loses with a 409.
    //   • The CLAIM CODE has only ever been on the invitee's own screen, and the
    //     client NEVER sends it on its own initiative: discoverInvite() tries
    //     link, then install referrer, then clipboard, and stops. A claim_code
    //     lookup is a person who typed six characters and pressed a button. It
    //     is the one credential whose arrival is evidence about WHO is asking
    //     rather than merely about what leaked, which is what makes it the only
    //     sound basis for "the same requester is retrying".
    //
    // The extra branch is `accept_hash: <the value this request just read>`,
    // not a blanket exemption, and that distinction is load-bearing. It makes
    // the re-mint a compare-and-SWAP: the row must still hold the token this
    // request saw, so of two claim-code lookups racing each other exactly one
    // writes and the other gets a 409 with no token at all. An unconditional
    // re-mint would instead hand both callers a token, store only the last, and
    // let the other one discover the difference by filling in an entire
    // registration form and receiving a bare 404 — recovery for one person
    // bought with a silent failure for the next.
    //
    // What this deliberately does NOT preserve is "an accept token issued to one
    // device stays valid until it expires". It cannot: recovering the flow means
    // the old token stops working, and a rule that spared it would be the empty
    // window again under a different name. What IS preserved — and it is the
    // property that matters — is that AT MOST ONE live accept token exists for
    // an invite at any instant, because the swap overwrites the single column
    // holding it. Two devices never both hold live tokens; the second one to
    // present the code takes the flow, and the first learns at submit. That is
    // the same exposure a forwarded link has always carried, and it is why every
    // open and every re-mint is written to the org's audit trail below.
    const accept_token = generateHandoffToken();
    const acceptExpiry = new Date(now.getTime() + ACCEPT_TTL_MS);
    const reminting = via === 'claim_code' && invite.accept_hash !== null;
    const minted = await db.invite.updateMany({
      where: {
        id: invite.id,
        consumed_at: null,
        revoked_at: null,
        // Only mint when no accept token is currently live. A second lookup
        // inside the window is a no-op rather than a rotation — unless it is the
        // typed recovery code naming the very token it would replace.
        OR: [
          { accept_hash: null },
          { accept_expires_at: { lte: now } },
          ...(reminting ? [{ accept_hash: invite.accept_hash as string }] : []),
        ],
      },
      data: {
        accept_hash: hashSecret(accept_token),
        accept_expires_at: acceptExpiry,
        handoff_hash: null,
      },
    });

    if (minted.count === 0) {
      // Another lookup won. Do not hand back a token that was never stored —
      // that would produce a form which 404s on submit for no visible reason.
      await auditLog({
        action: 'invite.lookup', outcome: 'denied', request,
        organizationId: invite.organization_id,
        metadata: { invite_id: invite.id, reason: 'accept_token_already_issued', via },
      });
      return reply.code(409).send({
        error: {
          code: 'INVITE_IN_PROGRESS',
          message: 'Приглашение уже открыто на другом устройстве. Завершите регистрацию там или откройте ссылку заново.',
        },
      });
    }

    await auditLog({
      action: 'invite.lookup', outcome: 'success', request,
      // Org-scoped so the OWNER can see it. listAuditEvents filters hard on
      // organization_id, so a row written without one is invisible to the only
      // person who would act on it — which made the audit trail useless for
      // exactly the two unauthenticated surfaces that most need watching.
      organizationId: invite.organization_id,
      // `reminted` is the one event in this flow that an owner might need to act
      // on. A single lookup is the invitee installing the app; a lookup that
      // REPLACED a live accept token is either that invitee recovering a killed
      // app — the ordinary case — or a second holder of a forwarded link taking
      // the registration away from them. The two are indistinguishable from
      // here, which is exactly why the owner is told rather than the server
      // guessing.
      metadata: { invite_id: invite.id, via, reminted: reminting },
    });

    return reply.send({
      data: {
        name: invite.name,
        role: invite.role,
        org_name: invite.organization.name,
        accept_token,
      },
      meta: {},
    });
  },

  /**
   * The invitee has filled in phone, email and a password of their own choosing.
   * This is where the User row is finally created — nothing before this point is
   * an account, so an unaccepted invite has no login surface.
   */
  accept: async (request: FastifyRequest, reply: FastifyReply) => {
    const { accept_token, phone, email: rawEmail, password } = request.body as {
      accept_token: string; phone: string; email: string; password: string;
    };
    const email = normalizeEmail(rawEmail);

    // accept_hash, never handoff_hash. The handoff has been through a
    // third-party query string and the system clipboard; it is not allowed to
    // create an account. Only a token minted by a successful lookup is.
    const invite = await db.invite.findUnique({
      where: { accept_hash: hashSecret(accept_token) },
      select: {
        id: true, name: true, role: true, organization_id: true, created_by: true,
        expires_at: true, consumed_at: true, revoked_at: true, accept_expires_at: true,
      },
    });

    if (!invite) return inviteUnavailable(reply);

    if (!invite.accept_expires_at || invite.accept_expires_at <= new Date()) {
      await auditLog({
        action: 'invite.accept', outcome: 'denied', request,
        organizationId: invite.organization_id,
        metadata: { invite_id: invite.id, reason: 'accept_token_expired' },
      });
      return inviteUnavailable(reply);
    }

    const rejection = inviteRejection(invite);
    if (rejection) {
      await auditLog({
        action: 'invite.accept', outcome: 'denied', request,
        organizationId: invite.organization_id,
        metadata: { invite_id: invite.id, reason: rejection },
      });
      return inviteUnavailable(reply);
    }

    // User.email is globally unique, not per-org, so this is a real collision
    // and not a tenancy question. Reported plainly: the invitee needs to know to
    // use a different address, and this leaks nothing they could not learn by
    // trying to register.
    const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      return reply.code(409).send({
        error: { code: 'EMAIL_TAKEN', message: 'Этот email уже используется' },
      });
    }

    const username = await uniqueUsernameForOrg(invite.organization_id, invite.name);
    const password_hash = await bcrypt.hash(password, saltRounds);

    const created = await db.$transaction(async (tx) => {
      // Consume FIRST, conditionally. `updateMany` with `consumed_at: null` in
      // the WHERE is an atomic compare-and-set: two devices redeeming the same
      // token concurrently produce one winner and one count === 0, rather than
      // two accounts.
      // Both expiries are re-checked HERE, not only before the transaction. The
      // pre-flight check runs, then bcrypt.hash at cost 12 takes 250-400 ms, and
      // an invite that lapses inside that window would otherwise still create an
      // account. Revocation was already covered by this CAS; expiry was not.
      //
      // The claim code is burned in the same statement — its job was to survive
      // as far as a successful accept, and it ends here.
      const claimed = await tx.invite.updateMany({
        where: {
          id: invite.id,
          consumed_at: null,
          revoked_at: null,
          expires_at: { gt: new Date() },
          accept_expires_at: { gt: new Date() },
        },
        data: {
          consumed_at: new Date(),
          accept_hash: null,
          accept_expires_at: null,
          claim_hash: null,
          claim_expires_at: null,
        },
      });
      if (claimed.count === 0) return null;

      const user = await tx.user.create({
        data: {
          organization_id: invite.organization_id,
          name: invite.name,
          username,
          email,
          phone,
          password_hash,
          role: invite.role,
          invited_by: invite.created_by,
          is_active: true,
          // The role came from the invite, the credentials from the invitee.
          // Nothing is left for a first-run screen to collect, so both
          // must_change flags stay false.
          must_change_password: false,
          must_change_email: false,
          // Neither address nor number has been proven yet. is_verified and
          // email_verified are set together by POST /auth/verify, whose code this
          // handler issues below and which is the ONLY way this account acquires
          // a session; phone_verified has no mechanism at all in this product (no
          // SMS provider) and stays false by design.
          is_verified: false,
          email_verified: false,
          phone_verified: false,
        },
        select: {
          id: true, email: true, username: true, name: true, role: true,
          organization_id: true, timezone: true,
          must_change_password: true, must_change_email: true, stay_signed_in: true,
        },
      });

      await tx.invite.update({ where: { id: invite.id }, data: { user_id: user.id } });
      return user;
    });

    if (!created) return inviteUnavailable(reply);

    await auditLog({
      action: 'invite.accept', outcome: 'success', request,
      organizationId: invite.organization_id,
      userId: created.id,
      metadata: { invite_id: invite.id, role: invite.role },
    });

    /**
     * THE ACCOUNT EXISTS. IT DOES NOT YET HAVE A LOGIN SURFACE.
     *
     * This used to sign a seven-day session here, immediately, on an address
     * nobody had proven — the row two dozen lines up says `email_verified: false`
     * and the comment beside it promised an OTP step that was never written. So
     * whoever held a forwarded invite link could type any address they liked,
     * including one belonging to somebody else, and use the organisation's CRM
     * for as long as they cared to.
     *
     * The tail below is register's, structurally verbatim (AuthController.register):
     * issue the code, try to deliver it, answer 201 with the user_id the client
     * needs to call POST /auth/verify. That endpoint sets is_verified and mints
     * the session — one screen later, on an address that has been proven.
     *
     * DELIVERY FAILURE MUST NOT ROLL ANYTHING BACK. The invite was consumed
     * inside the transaction and the row is committed; throwing here would burn
     * a single-use invite and leave an account nobody can reach. A caller that
     * sees meta.email_sent === false calls POST /auth/verify/resend, exactly as
     * a registrant does.
     */
    if (isEmailVerificationEnforced()) {
      let emailDelivered = false;
      try {
        const emailCode = await issueCode(created.id, 'email');
        const emailResult = isEmailSendingEnabled()
          ? await sendEmail(email, 'Код подтверждения', `Ваш код: ${emailCode}. Действителен 10 минут.`)
          : { success: false };
        emailDelivered = emailResult.success;
      } catch {
        // silent — the invitee can call POST /auth/verify/resend
      }

      return reply.code(201).send({
        data: { user_id: created.id, email: created.email, needs_verification: true },
        meta: { email_sent: emailDelivered },
      });
    }

    // REQUIRE_EMAIL_VERIFICATION=false — the pre-fix shape, kept whole so the
    // switch is a real revert and not a half one. See isEmailVerificationEnforced.
    const token = await signSessionToken(request, reply, {
      id: created.id,
      organization_id: created.organization_id,
      role: created.role,
      stay_signed_in: created.stay_signed_in,
    });

    return reply.code(201).send({
      data: {
        user: {
          id: created.id,
          email: created.email,
          username: created.username,
          name: created.name,
          role: created.role,
          org_id: created.organization_id,
          timezone: created.timezone,
          onboarding_completed: false,
          must_change_password: created.must_change_password,
          must_change_email: created.must_change_email,
        },
        token,
      },
      meta: {},
    });
  },
};
