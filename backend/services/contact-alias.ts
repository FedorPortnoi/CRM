import { createHash } from 'node:crypto';

/**
 * Contact-name aliasing: what makes Wave A possible rather than merely forbidden.
 *
 * -----------------------------------------------------------------------------
 * THE PROBLEM WITH THE OBVIOUS FIX
 * -----------------------------------------------------------------------------
 * Operator ФИО is handled by DROPPING it (model-projection.ts): the id beside it
 * already says a person is attached, so nothing is lost. That does not work for
 * the contact. The contact IS the subject of the question. Strip the name and
 * «с кем из клиентов давно не связывались?» can only be answered with a uuid,
 * which is a worse product for no additional safety — the model still learns
 * that a specific person exists, it just cannot say who.
 *
 * Four session records recorded this as a conflict between ФЗ-152 and the
 * requirement that the assistant be exactly as capable as the user. It is not a
 * conflict. Those are different axes: one is about what may LEAVE, the other
 * about what the user may DO. Aliasing satisfies both.
 *
 * -----------------------------------------------------------------------------
 * HOW IT WORKS
 * -----------------------------------------------------------------------------
 * Each contact gets a stable pseudonym derived from its uuid, e.g. «Клиент K7F3».
 * The model sees only pseudonyms, reasons over them normally, and writes prose
 * that refers to «Клиент K7F3». On the way back to the human, the pseudonyms are
 * swapped for the real names.
 *
 *   tool result   → alias  → provider   (never sees a real name)
 *   provider text → rehydrate → user    (never sees a pseudonym)
 *
 * Three properties make this safe to persist:
 *
 *   1. DERIVED FROM THE ID, not from a counter. The same contact gets the same
 *      alias on every turn and in every conversation, so a stored transcript
 *      still resolves days later. A per-request counter would make yesterday's
 *      history unreadable.
 *   2. NOT DERIVED FROM THE NAME. The alias is a hash of the uuid only. Two
 *      contacts called «Иван Петров» get different aliases, and — more
 *      importantly — the alias leaks nothing about the name it replaces.
 *   3. THE STORED PROSE IS THE ALIASED PROSE. Because the model only ever saw
 *      pseudonyms, what it wrote already contains pseudonyms. Persisting its
 *      output verbatim therefore stores no names, so replaying history to the
 *      provider on a later turn is safe by construction rather than by a second
 *      scrubbing pass that could miss a case.
 *
 * FAILURE DIRECTION: if the model mangles an alias, rehydration simply does not
 * match and the user sees «Клиент K7F3». Degraded, never leaked. That is the
 * correct way for this to break.
 */

/**
 * Visible markers, so an un-rehydrated alias is obviously a placeholder rather
 * than a name — and so the two KINDS of person stay distinguishable in prose.
 * «Сотрудник K7F3 закрыл сделку с Клиентом M2QX» is still a sentence the model
 * can reason about; two identical prefixes would not be.
 *
 * Deliberately Russian words rather than the `USER-<hex>` shape used by
 * identityHandle() in assistant.ts. Those handles are machine tokens the system
 * prompt explicitly tells the model NOT to print (rule 6), so reusing them here
 * would need the instruction to be true for one tool and false for another —
 * and an instruction is not a guarantee. A word the model is happy to write is
 * a better substrate for something that has to survive being written.
 */
const ALIAS_PREFIXES = {
  contact: 'Клиент',
  user: 'Сотрудник',
} as const;

const ALIAS_PREFIX = ALIAS_PREFIXES.contact;

/**
 * 4 bytes of a sha256 over the uuid, base32-ish. ~1.05M values: ample for one
 * organisation's contact book, and collisions only ever merge two aliases in a
 * single prompt, never reveal anything.
 *
 * Deliberately NOT the raw uuid prefix: a uuid is a database identifier, and
 * handing the provider a stable primary key across sessions is its own small
 * disclosure. A hash is opaque and equally stable.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — unambiguous when read aloud

function aliasToken(id: string): string {
  const digest = createHash('sha256').update(String(id)).digest();
  let n = digest.readUInt32BE(0);
  let token = '';
  for (let i = 0; i < 4; i += 1) {
    token = ALPHABET[n % ALPHABET.length] + token;
    n = Math.floor(n / ALPHABET.length);
  }
  return token;
}

export function aliasForContactId(contactId: string): string {
  return `${ALIAS_PREFIXES.contact} ${aliasToken(contactId)}`;
}

/**
 * The same treatment for an OPERATOR, used by get_rep_performance — the one
 * tool whose answer IS a list of named people, and therefore the one place the
 * MCP projection cannot simply delete the name (see
 * docs/decisions/002-operator-names-in-model-facing-analytics.md, option (b)).
 */
export function aliasForUserId(userId: string): string {
  return `${ALIAS_PREFIXES.user} ${aliasToken(userId)}`;
}

/** Matches any alias this module can emit, for the rehydration sweep. */
const ALIAS_PATTERN = new RegExp(
  `(?:${ALIAS_PREFIXES.contact}|${ALIAS_PREFIXES.user})\\s+[${ALPHABET}]{4}`,
  'g',
);

export type ContactIdentity = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
};

/** alias → real display name, for turning the model's answer back into Russian. */
export type AliasMap = Map<string, string>;

export function displayNameOf(contact: ContactIdentity): string {
  return [contact.first_name, contact.last_name]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(' ')
    .trim();
}

/**
 * Build the alias→name map for every contact about to be mentioned.
 *
 * Contacts with no usable name are skipped: there is nothing to hide and nothing
 * to restore, and inventing an alias for them would tell the model that a name
 * exists when it does not.
 */
export function buildAliasMap(contacts: readonly ContactIdentity[]): AliasMap {
  const map: AliasMap = new Map();
  for (const c of contacts) {
    const name = displayNameOf(c);
    if (!name) continue;
    map.set(aliasForContactId(c.id), name);
  }
  return map;
}

/**
 * The operator half. `User.name` is a single ФИО column rather than a first/last
 * pair, so this takes rows as they come out of Prisma.
 */
export function buildUserAliasMap(
  users: readonly { id: string; name?: string | null }[],
): AliasMap {
  const map: AliasMap = new Map();
  for (const u of users) {
    const name = u.name?.trim();
    if (!name) continue;
    map.set(aliasForUserId(u.id), name);
  }
  return map;
}

/**
 * Replace a contact's real name with its alias, everywhere it appears in a
 * free-text value.
 *
 * Longest name first: «Иван Петров» must be consumed before a bare «Иван», or
 * the surname survives as a fragment next to the alias — which would leak
 * exactly the thing being hidden.
 *
 * Also aliases the bare first and last name separately, because prose routinely
 * refers to «Иван» alone after introducing him in full.
 */
export function aliasNamesInText(text: string, contacts: readonly ContactIdentity[]): string {
  if (!text) return text;

  const replacements: Array<{ find: string; alias: string }> = [];
  for (const c of contacts) {
    const alias = aliasForContactId(c.id);
    const full = displayNameOf(c);
    if (full) replacements.push({ find: full, alias });
    for (const part of [c.first_name, c.last_name]) {
      const p = part?.trim();
      // Single letters and initials would match far too much prose.
      if (p && p.length > 2) replacements.push({ find: p, alias });
    }
  }

  replacements.sort((a, b) => b.find.length - a.find.length);

  let out = text;
  for (const { find, alias } of replacements) {
    out = out.split(find).join(alias);
  }
  return out;
}

/**
 * Turn the model's answer back into something a human recognises.
 *
 * An alias with no entry in the map is left exactly as it is rather than being
 * blanked: it means the model invented or mangled a token, and showing the
 * placeholder is honest, whereas erasing it would hide that the answer referred
 * to something we could not identify.
 */
export function rehydrateAliases(text: string, map: AliasMap): string {
  if (!text || map.size === 0) return text;
  return text.replace(ALIAS_PATTERN, (match) => map.get(match) ?? match);
}

/** True when a string still carries an alias — used by tests and assertions. */
export function containsAlias(text: string): boolean {
  ALIAS_PATTERN.lastIndex = 0;
  return ALIAS_PATTERN.test(text);
}
