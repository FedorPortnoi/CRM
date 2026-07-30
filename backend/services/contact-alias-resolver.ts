import { db } from './db';
import {
  aliasNamesInText,
  buildAliasMap,
  buildUserAliasMap,
  containsAlias,
  rehydrateAliases,
  type AliasMap,
  type ContactIdentity,
} from './contact-alias';
import { personalNamesMayBeSent } from './model-jurisdiction';

/**
 * The database half of contact aliasing: turning aliases back into names, and
 * catching names on their way OUT of a user's own message.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO ALIAS TABLE
 * ---------------------------------------------------------------------------
 * An alias is a pure function of the contact id, so the whole alias→name map is
 * RECONSTRUCTIBLE at any time from the org's own contact rows. Nothing has to be
 * stored, no migration is needed, and there is no second copy of the mapping to
 * fall out of sync or to leak on its own.
 *
 * The cost is one narrow query — three columns, one org — and it is paid only
 * when both of these hold:
 *
 *   1. the configured provider is not domestic (so aliasing is active at all),
 *   2. the text in hand actually contains an alias token.
 *
 * Under today's YandexGPT configuration neither holds, so this file adds exactly
 * zero queries to the live path. That is deliberate: a precondition that slows
 * down the product it is protecting gets removed by the next person who profiles
 * the endpoint.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER DIRECTION
 * ---------------------------------------------------------------------------
 * `aliasNamesInOutgoingText` covers the hole the MCP projection structurally
 * cannot: the user types «что там по Иванову?» and that sentence goes to the
 * provider verbatim, having never been a tool result. Prose has no shape to key
 * on, so the only way to catch it is to match against the names this org
 * actually holds — which is possible here precisely because this module has the
 * contact table in front of it.
 *
 * LIMIT, stated plainly: matching is on the stored form of the name. Russian
 * inflection is usually suffixal, so «Иванов» still matches inside «Иванову» and
 * the surname is removed — but the trailing «у» survives as noise, and a name
 * whose stem changes is missed. This is a real reduction, not a guarantee, and
 * it is applied on top of the structural aliasing rather than instead of it.
 */

const MAX_CONTACTS_SCANNED = 5000;

/**
 * Every named contact in the org, cheapest possible select.
 *
 * The cap is a latency guard, not a correctness boundary: an org past it gets
 * partial rehydration (an unresolved alias renders as «Клиент K7F3», which is
 * degraded but not a leak) and partial outbound aliasing. Ordering by
 * `updated_at` puts the contacts a conversation is most likely to be about
 * inside the window.
 */
async function loadOrgContacts(orgId: string): Promise<ContactIdentity[]> {
  return db.contact.findMany({
    where: { organization_id: orgId },
    select: { id: true, first_name: true, last_name: true },
    orderBy: { updated_at: 'desc' },
    take: MAX_CONTACTS_SCANNED,
  });
}

/**
 * Operators, for the reverse direction only.
 *
 * There is no outbound counterpart: an operator's ФИО is aliased at the tool
 * that emits it (get_rep_performance) rather than by matching prose, because
 * decision 002 rejected inbound name-matching for operators — it fails open on
 * inflected Russian surnames and would have to spare the sentences that same
 * tool is allowed to produce. Aliasing at the source has neither problem.
 */
async function loadOrgUsers(orgId: string): Promise<Array<{ id: string; name: string | null }>> {
  return db.user.findMany({
    where: { organization_id: orgId },
    select: { id: true, name: true },
    take: MAX_CONTACTS_SCANNED,
  });
}

/**
 * The full alias→name table for an org: contacts and operators together.
 *
 * Both are needed because one answer can carry both kinds — «Сотрудник K7F3
 * закрыл сделку с Клиентом M2QX» — and resolving only half of it would leave a
 * raw handle in the middle of an otherwise finished Russian sentence.
 */
async function loadRehydrationMap(orgId: string): Promise<AliasMap> {
  const [contacts, users] = await Promise.all([loadOrgContacts(orgId), loadOrgUsers(orgId)]);
  return new Map([...buildAliasMap(contacts), ...buildUserAliasMap(users)]);
}

/**
 * Everything a single assistant turn needs to alias in both directions, loaded
 * once.
 *
 * `null` means aliasing is off for this deployment — the provider is domestic —
 * and every caller below treats that as "pass the text through untouched". A
 * null-check at each site reads better than a boolean beside a possibly-empty
 * list, because there is no way to confuse "aliasing is off" with "this org has
 * no contacts".
 */
export type AliasContext = { contacts: ContactIdentity[] };

export async function loadAliasContext(orgId: string): Promise<AliasContext | null> {
  if (personalNamesMayBeSent()) {
    return null;
  }

  return { contacts: await loadOrgContacts(orgId) };
}

/** Outbound: real names → aliases. Pass-through when aliasing is off. */
export function aliasWith(ctx: AliasContext | null, text: string): string {
  return ctx ? aliasNamesInText(text, ctx.contacts) : text;
}

/**
 * Swap aliases for real names before a string is shown to a human.
 *
 * Driven by what is IN THE TEXT, not by the configured provider. That
 * distinction matters: operator aliases can appear under the domestic provider
 * too if the tool that emits them is ever switched on there, and a stored
 * transcript written under one provider can be read under another. Keying on the
 * text means rehydration is correct in all four combinations instead of the two
 * the current configuration happens to produce.
 *
 * Safe to call unconditionally — it short-circuits before touching the database
 * whenever the text holds no alias, which is every string on today's live path.
 */
export async function rehydrateForDisplay(orgId: string, text: string): Promise<string> {
  if (!text || !containsAlias(text)) {
    return text;
  }

  return rehydrateAliases(text, await loadRehydrationMap(orgId));
}

/** The same, over a list of stored messages. One pair of queries per transcript. */
export async function rehydrateMessagesForDisplay<T extends { content: string }>(
  orgId: string,
  messages: T[],
): Promise<T[]> {
  if (!messages.some((m) => containsAlias(m.content))) {
    return messages;
  }

  const map = await loadRehydrationMap(orgId);
  return messages.map((m) => ({ ...m, content: rehydrateAliases(m.content, map) }));
}

/**
 * Replace contact names with their aliases in free text that is about to be sent
 * to the provider.
 *
 * A no-op under a domestic provider: there the name may lawfully be sent, and
 * rewriting the user's own sentence would only make the model answer a question
 * nobody asked.
 */
export async function aliasNamesInOutgoingText(orgId: string, text: string): Promise<string> {
  if (!text || personalNamesMayBeSent()) {
    return text;
  }

  const contacts = await loadOrgContacts(orgId);
  return aliasNamesInText(text, contacts);
}
