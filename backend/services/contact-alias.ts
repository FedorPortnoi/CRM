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

/**
 * The case endings Russian will attach to an alias word.
 *
 * -----------------------------------------------------------------------------
 * WHY THE PATTERN IS NOT SIMPLY «Клиент|Сотрудник»
 * -----------------------------------------------------------------------------
 * The Russian-word substrate was chosen above precisely because such a word
 * "survives being written" by a model that is not trying to preserve it. That
 * choice has a consequence the first version of this pattern did not draw: a
 * word the model is happy to write is a word it will DECLINE. Prose does not say
 * «сделка с Клиент K7F3»; it says «сделка с Клиентом K7F3», «позвонить Клиенту
 * K7F3», «у Клиента K7F3». The alias is EMITTED in the nominative and the model
 * puts it into whatever case the sentence needs — that is not the model mangling
 * anything, it is the model writing correct Russian around our token.
 *
 * A nominative-only pattern therefore failed on the exact sentence the resolver's
 * own docstring uses as its worked example: «Сотрудник K7F3 закрыл сделку с
 * Клиентом M2QX» matched the first half and missed the second, producing the
 * half-resolved sentence that comment says cannot happen. And because
 * containsAlias() shares this pattern, an answer whose aliases were ALL inflected
 * — one «Клиенту K7F3» and nothing else — reported "no aliases here", so
 * rehydrateForDisplay short-circuited before the map was even loaded and the user
 * was shown the raw handle.
 *
 * ENDINGS, NOT `\w*`. The obvious widening — `Клиент\w*\s+[TOKEN]` — is a worse
 * bug than the one it fixes. It matches the ordinary word «Клиенту» wherever four
 * token-shaped characters happen to follow (an order code, an abbreviation) and
 * would rewrite that into somebody's real name: inventing a person where none was
 * mentioned, which is a fabrication rather than a degradation. The list below is
 * the actual paradigm of a second-declension masculine animate noun, shared by
 * both words, so «Клиентура», «Клиентский» and «Сотрудничество» are not alias
 * forms and do not match. The map lookup in rehydrateAliases() is the second
 * guard: a four-character token that is not a live alias resolves to nothing and
 * the text comes back untouched.
 *
 * Ordered longest-first so «Клиентами» is consumed whole rather than as
 * «Клиента» + a stranded «ми».
 */
const ALIAS_CASE_ENDINGS = ['ами', 'ам', 'ах', 'ом', 'ов', 'а', 'у', 'е', 'ы', 'и'] as const;

/**
 * Matches any alias this module can emit, in any case form, for the rehydration
 * sweep. Two captures: the alias WORD and the TOKEN, which is everything the
 * lookup key needs (see aliasKey below).
 *
 * The lookbehind stops a longer word that merely ends in an alias word —
 * «Субклиенту K7F3» — from being read as one. `\b` cannot do that job here: JS
 * defines it over `[A-Za-z0-9_]`, so it does not consider a Cyrillic letter a
 * word character at all and `\bКлиент` would never match in Russian text.
 */
const ALIAS_PATTERN = new RegExp(
  `(?<![А-Яа-яЁё])(${ALIAS_PREFIXES.contact}|${ALIAS_PREFIXES.user})` +
    `(?:${ALIAS_CASE_ENDINGS.join('|')})?\\s+([${ALPHABET}]{4})`,
  'g',
);

/**
 * The nominative form of a matched alias — the shape buildAliasMap() keys by.
 *
 * Rebuilding the key from the two captures rather than looking up the matched
 * text is what makes «Клиентом M2QX» find the same entry as «Клиент M2QX». It
 * also normalises the separator, so «Клиент⏎K7F3» and «Клиент  K7F3» now resolve
 * too — both matched the old pattern and then failed the lookup, because the key
 * it searched for carried the model's own whitespace.
 */
function aliasKey(word: string, token: string): string {
  return `${word} ${token}`;
}

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
 * to something we could not identify. That same branch is what keeps the widened
 * pattern safe — «Клиенту ACME» in a sentence that was never about an alias
 * resolves to nothing and is returned verbatim.
 *
 * THE NAME COMES BACK IN THE NOMINATIVE, whatever case the alias was in:
 * «сделка с Клиентом M2QX» becomes «сделка с Мария Соколова», not «с Марией
 * Соколовой». That is accepted, not overlooked. Declining a Russian surname
 * correctly needs a morphology dependency, and that exact trade-off was already
 * weighed for the operator half in
 * docs/decisions/002-operator-names-in-model-facing-analytics.md — "genuine
 * costs", item 1: "Fixable only with a morphology library or by constraining the
 * model to a fixed frame; otherwise accept slightly stilted output." The
 * requirement is that the name APPEAR; agreement with its preposition is
 * cosmetic, and the alternative — leaving «Клиентом M2QX» on the screen — is the
 * failure this function exists to prevent. Please do not re-open this with a
 * morphology library.
 */
export function rehydrateAliases(text: string, map: AliasMap): string {
  if (!text || map.size === 0) return text;
  return text.replace(
    ALIAS_PATTERN,
    (match: string, word: string, token: string) => map.get(aliasKey(word, token)) ?? match,
  );
}

/**
 * True when a string still carries an alias — used by tests and assertions, and
 * by rehydrateForDisplay() to decide whether a database round-trip is needed.
 *
 * It MUST stay on the same ALIAS_PATTERN as rehydrateAliases(). If the two ever
 * drift, the narrower one silently wins: a text this predicate calls clean is a
 * text the resolver never loads a map for, so a form that only rehydrateAliases()
 * knows about is a form the user never sees resolved.
 */
export function containsAlias(text: string): boolean {
  ALIAS_PATTERN.lastIndex = 0;
  return ALIAS_PATTERN.test(text);
}
