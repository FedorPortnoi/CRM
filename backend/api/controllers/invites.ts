import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { db } from '../../services/db';
import { auditLog } from '../../services/audit';
import { assignableRoles, isRole } from '../../services/capabilities';
import { signSessionToken, uniqueUsernameForOrg, normalizeEmail } from './auth';
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

    const handoff = generateHandoffToken();
    const claimCode = generateClaimCode();
    const now = new Date();

    await db.invite.update({
      where: { id: invite.id },
      data: {
        handoff_hash: hashSecret(handoff),
        claim_hash: hashSecret(claimCode),
        claim_expires_at: new Date(now.getTime() + CLAIM_TTL_MS),
        opened_at: invite.opened_at ?? now,
      },
    });

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
      invite = await db.invite.findFirst({
        where: {
          claim_hash: hashSecret(code),
          claim_expires_at: { gt: now },
          consumed_at: null,
          revoked_at: null,
        },
        select,
      });
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
    // simply retype the code. It is 15-minute, rate-limited, and can only ever
    // be traded for a fresh accept token, never spent directly.
    //
    // The write is CONDITIONAL so two concurrent lookups cannot both mint. The
    // app deliberately tries several credentials in order of reliability, so a
    // Universal Link opening alongside a stored install referrer is an ordinary
    // race, not an edge case — and the loser must not silently invalidate the
    // accept token the winner just handed to the form.
    const accept_token = generateHandoffToken();
    const acceptExpiry = new Date(now.getTime() + ACCEPT_TTL_MS);
    const minted = await db.invite.updateMany({
      where: {
        id: invite.id,
        consumed_at: null,
        revoked_at: null,
        // Only mint when no accept token is currently live. A second lookup
        // inside the window is a no-op rather than a rotation.
        OR: [{ accept_hash: null }, { accept_expires_at: { lte: now } }],
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
      metadata: { invite_id: invite.id, via },
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
          // Neither address nor number has been proven yet. email_verified is
          // set by the OTP step that follows; phone_verified has no mechanism at
          // all in this product (no SMS provider) and stays false by design.
          is_verified: false,
          email_verified: false,
          phone_verified: false,
        },
        select: {
          id: true, email: true, username: true, name: true, role: true,
          organization_id: true, must_change_password: true, must_change_email: true,
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

    const token = await signSessionToken(request, reply, {
      id: created.id,
      organization_id: created.organization_id,
      role: created.role,
    });

    return reply.code(201).send({ data: { user: created, token }, meta: {} });
  },
};
