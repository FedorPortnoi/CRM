/**
 * contact-name-match.ts
 *
 * Picks at most one contact out of a candidate list by matching a free-text
 * Russian task title against the contacts' names, entirely in this process.
 *
 * It exists so POST /tasks/suggest-contact does not have to put up to 300
 * customers' full names into a model prompt. Nothing here reaches the network,
 * so the route's exposure no longer moves when the provider seam moves.
 *
 * ── Why not PostgreSQL full-text search ────────────────────────────────────
 *
 * The obvious answer is `to_tsvector('russian', …)`: Snowball strips case
 * endings, it is GIN-indexable, and backend/db/schema/contacts.sql:26 already
 * sketches an `fts` column (with 'english', and it was never migrated — the
 * column is absent from backend/prisma/schema.prisma and from all 26
 * migrations, so today it does not exist in any database).
 *
 * It was evaluated and it loses, for a reason that only shows up on names.
 * Snowball Russian is a stemmer for *common words*, and its NOUN ending list
 * contains "ов"/"ев" — which on a surname are not a case ending at all, they
 * are the patronymic-derived suffix that makes the surname a surname. So:
 *
 *     Петров  → петр      Петрова → петров     Петрову → петров
 *     Иванов  → иван      Иванова → иванов     Иванову → иванов
 *     Иван    → ива       Ивана   → ива        Ивану   → иван
 *
 * The nominative form lands on a *different* stem from every oblique form, so
 * the route's own canonical example — title "Позвонить Ивану Петрову" against
 * contact "Иван Петров" — shares zero stems and matches nothing. It also
 * collides in the other direction: Петров and Пётр both stem to "петр", so a
 * task about Пётр Сидоров would match a contact named Петров.
 *
 * On top of that, using it at all would need either a migration (out of scope
 * here) or a per-request `to_tsvector(…)` expression in $queryRaw — an
 * unindexed sequential scan that buys none of the GIN benefit while moving the
 * matching rules out of reach of the unit suite.
 *
 * ── What this does instead ─────────────────────────────────────────────────
 *
 * The opposite of stemming. Rather than cutting each word down to a guessed
 * root — which is where Snowball goes wrong, because it cuts *too much* — two
 * words are compared directly and are called the same name when they share a
 * stem and differ only by a Russian singular case ending drawn from a closed
 * list. Nothing is ever removed from a word, so "Петров" can never collapse
 * into "Пётр": "ов" is not on the list and never will be.
 *
 * That covers the three inflecting parts of a Russian name (given name,
 * surname and patronymic) and the adjectival surnames (Толстой, Достоевская).
 * Diminutives cannot be derived from spelling at all — Ваня is not a suffixed
 * Иван — so they come from a small explicit table, and an unlisted diminutive
 * degrades to "no suggestion" rather than to a guess.
 *
 * ── The failure this design has, and what holds it back ────────────────────
 *
 * A model reading "Написать роман" understood that роман was a novel. A token
 * matcher has no context and cannot: several ordinary Russian given names are
 * also common nouns (Роман, Вера, Надежда, Любовь, Лев), and several entries in
 * the diminutive table below are noun-shaped too (света, слава, рома, лена,
 * соня). Left alone this matcher answers "Написать роман" with a contact named
 * Роман — the wrong-person-attached-to-a-task case the caller's strict UUID
 * parsing exists to avoid.
 *
 * So a match on one of those words, on its own, is not enough. Such a word is
 * treated as WEAK evidence: it can confirm a contact the title names some other
 * way, but it cannot pick one by itself. "Написать роман" suggests nobody;
 * "Написать роман Ковалёву" still suggests Роман Ковалёв, because the surname
 * carries it. Two-letter tokens are weak for the same reason — «ли» is both a
 * question particle and a real surname, and "оплатил ли клиент" must not answer
 * with Сергей Ли, while "Позвонить Сергею Ли" still must.
 *
 * Known gaps, accepted deliberately: names with a fleeting vowel (Павел/Павла,
 * Лев/Льва) only match in the form they are stored in, and non-Cyrillic names
 * match exactly or not at all. Both fail towards "no suggestion".
 */

/** The contact fields this module needs; callers may pass wider rows. */
export type NameCandidate = {
  id: string;
  first_name: string;
  last_name: string | null;
};

/**
 * Russian singular case endings, after normalization (so no ё appears here).
 *
 * Every entry earns its place by a real declension pair:
 *   а я у ю е и ы  — Иванова, Мария, Иванову, Марию, Иване, Марии, Ивановны
 *   ь й            — Лебедь/Лебедя, Сергей/Сергея
 *   ой ей ою ею    — Ольгой, Натальей, Ольгою, Марфою
 *   ом ем ым им    — Иваном, Сергеем, Ивановым, Ильиным
 *   ий ый ая яя ую юю — adjectival surnames: Горький, Толстый, Достоевская
 *   ья ье ью       — Наталья/Наталье (the ь is inside the shared stem)
 *   ого его ому ему — Толстого, Горького, Толстому
 *
 * Deliberately ABSENT: ов, ев, ин, ын, ск, ич. Those are surname- and
 * patronymic-forming suffixes, not case endings. Admitting them is precisely
 * the mistake that makes Snowball equate Петров with Пётр, and it would make
 * this matcher answer with the wrong person rather than with nobody.
 */
const CASE_ENDINGS: ReadonlySet<string> = new Set([
  'а', 'я', 'у', 'ю', 'е', 'и', 'ы', 'ь', 'й',
  'ой', 'ей', 'ою', 'ею', 'ом', 'ем', 'ым', 'им',
  'ий', 'ый', 'ая', 'яя', 'ую', 'юю', 'ья', 'ье', 'ью',
  'ого', 'его', 'ому', 'ему',
]);

/**
 * Below this many shared leading letters two words are only the same name if
 * they are spelled identically. Three is where "Ольга"/"Ольгой" still works
 * while "Ян"/"Яна" and "Ева"/"Еве" — different people with a two-letter stem —
 * stop being merged.
 */
const MIN_SHARED_STEM = 3;

/** One-letter tokens are Russian prepositions and conjunctions, never names. */
const MIN_TOKEN_CHARS = 2;

/**
 * Common Russian diminutives → the full given name(s) they stand for.
 *
 * Necessarily incomplete and meant to be extended. It is consulted only for
 * given names, never for surnames, and only through the same case-ending
 * comparison as everything else — so the inflected forms ("Ване", "Сашей")
 * resolve without needing their own rows. An entry may map to more than one
 * full name (Саша is both Александр and Александра); the caller's ambiguity
 * rule then decides, which is the point — a diminutive earns a suggestion only
 * when exactly one contact ends up ahead.
 */
const DIMINUTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['ваня', ['иван']],
  ['саша', ['александр', 'александра']],
  ['шура', ['александр', 'александра']],
  ['дима', ['дмитрий']],
  ['миша', ['михаил']],
  ['сережа', ['сергей']],
  ['леша', ['алексей']],
  ['коля', ['николай']],
  ['вася', ['василий']],
  ['петя', ['петр']],
  ['женя', ['евгений', 'евгения']],
  ['катя', ['екатерина']],
  ['маша', ['мария']],
  ['света', ['светлана']],
  ['таня', ['татьяна']],
  ['оля', ['ольга']],
  ['лена', ['елена']],
  ['наташа', ['наталья', 'наталия']],
  ['ира', ['ирина']],
  ['юля', ['юлия']],
  ['настя', ['анастасия']],
  ['даша', ['дарья']],
  ['вика', ['виктория']],
  ['аня', ['анна']],
  ['галя', ['галина']],
  ['люда', ['людмила']],
  ['надя', ['надежда']],
  ['толя', ['анатолий']],
  ['боря', ['борис']],
  ['гриша', ['григорий']],
  ['костя', ['константин']],
  ['леня', ['леонид']],
  ['паша', ['павел']],
  ['рома', ['роман']],
  ['слава', ['вячеслав', 'святослав']],
  ['стас', ['станислав']],
  ['федя', ['федор']],
  ['юра', ['юрий']],
  ['витя', ['виктор']],
  ['вова', ['владимир']],
  ['володя', ['владимир']],
  ['лиза', ['елизавета']],
  ['зина', ['зинаида']],
  ['соня', ['софия', 'софья']],
  ['ксюша', ['ксения']],
  ['валя', ['валентин', 'валентина']],
];

const NO_EXPANSION: readonly string[] = [];

/**
 * Given names and diminutives that are also ordinary Russian words.
 *
 * Matching one of these proves nothing on its own, because the title probably
 * meant the noun. Listed in the nominative; the comparison goes through
 * `sameName`, so the inflected forms ("романа", "веру", "надеждой") are covered
 * without their own rows.
 *
 * Only words that genuinely collide belong here. Дмитрий and Михаил are not
 * nouns, so putting them here would suppress good suggestions for nothing.
 */
const WEAK_TITLE_WORDS: readonly string[] = [
  // Given names that are common nouns.
  'роман',   // a novel
  'вера',    // faith
  'надежда', // hope
  'любовь',  // love
  'лев',     // a lion
  // Diminutives from the table above that are also nouns or noun forms.
  'света',   // "свет" in the genitive/accusative — light
  'слава',   // glory ("слава богу")
  'рома',    // rum
  'лена',    // the river
  'соня',    // a dormouse; a sleepyhead
];

/**
 * Below this many letters a title word carries too little information to pick a
 * person by itself. Two-letter surnames are real (Ли, Ан, Ю) so they are not
 * excluded from matching — they are merely required to be corroborated, which
 * also disposes of «ли», «же», «бы», «то», «уж» and every other short Russian
 * function word without maintaining a stop-list of them.
 */
const STRONG_TITLE_TOKEN_CHARS = 3;

/** True when a matching title word is too weak to carry a suggestion alone. */
function isWeakTitleToken(token: string): boolean {
  return (
    token.length < STRONG_TITLE_TOKEN_CHARS ||
    WEAK_TITLE_WORDS.some((word) => sameName(token, word))
  );
}

/** Letters only — this also splits Римский-Корсаков into two matchable parts. */
const WORD_RE = /\p{L}+/gu;

/**
 * Case-folded, ё collapsed onto е.
 *
 * Case is folded rather than read as a signal: the task-title input in
 * src/app/task/new.tsx sets no autoCapitalize, so React Native's 'sentences'
 * default capitalises the first word of the title and leaves every name typed
 * after it lower-case. "позвонить ивану петрову" must behave exactly like
 * "Позвонить Ивану Петрову".
 */
function normalize(word: string): string {
  return word.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

/** Normalized word tokens of a title or of a stored name field. */
export function nameTokens(value: string | null | undefined): string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }

  const tokens: string[] = [];
  for (const match of value.matchAll(WORD_RE)) {
    const token = normalize(match[0]);
    if (token.length >= MIN_TOKEN_CHARS) {
      tokens.push(token);
    }
  }

  return tokens;
}

function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

/** No entry in CASE_ENDINGS is longer than this. */
const MAX_ENDING_CHARS = 3;

/**
 * True when two tokens are the same name in (possibly) different cases:
 * identical, or a shared stem plus a legal case ending on each side. Both
 * arguments must already have been through `nameTokens` — nothing is folded
 * here, so a raw "Соловьёв" would not compare equal to "соловьева".
 *
 * The split point is searched rather than assumed, because the longest common
 * prefix can swallow the first letter of both endings: "толстой"/"толстому"
 * share "толсто", leaving "й" and "му", which are not endings — the true split
 * is "толст" + "ой"/"ому". Backing off is bounded by the longest ending, so
 * this is at most four comparisons and cannot wander into a short stem.
 *
 * Both tails are checked, not just one, so this stays symmetric and so a long
 * unexplained tail ("иванко" vs "иванов", tails "ко"/"ов") is rejected instead
 * of being written off as noise.
 */
export function sameName(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }

  const prefix = sharedPrefixLength(a, b);
  const shortest = Math.max(MIN_SHARED_STEM, prefix - MAX_ENDING_CHARS);

  for (let stem = prefix; stem >= shortest; stem -= 1) {
    if (isCaseEnding(a.slice(stem)) && isCaseEnding(b.slice(stem))) {
      return true;
    }
  }

  return false;
}

function isCaseEnding(tail: string): boolean {
  return tail.length === 0 || CASE_ENDINGS.has(tail);
}

function expandDiminutive(token: string): readonly string[] {
  for (const [short, full] of DIMINUTIVES) {
    if (sameName(token, short)) {
      return full;
    }
  }
  return NO_EXPANSION;
}

/** A full given name the title may be referring to by a diminutive. */
type TitleAlias = {
  full: string;
  /** The title word that produced it — this is what the weak-evidence test judges. */
  source: string;
};

/**
 * The title, prepared once for the whole candidate list.
 *
 * The title→full direction of the diminutive table is scanned once here rather
 * than per candidate. (The reverse direction still runs inside the loop, in
 * `matchTitleTokenGiven`, because it is keyed on the contact's own name; at the
 * 300-candidate cap that is cheap enough to leave alone.)
 */
type TitleQuery = {
  /** Words of the title, normalized. */
  tokens: readonly string[];
  /** Full given names a word of the title could be a diminutive of. */
  aliases: readonly TitleAlias[];
};

function buildTitleQuery(title: string): TitleQuery {
  const tokens = nameTokens(title);
  const aliases: TitleAlias[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    for (const full of expandDiminutive(token)) {
      const key = `${full} ${token}`;
      if (!seen.has(key)) {
        seen.add(key);
        aliases.push({ full, source: token });
      }
    }
  }

  return { tokens, aliases };
}

/**
 * The title word that matches `token`, or null.
 *
 * Returns the word rather than a boolean because the caller has to weigh how
 * much that particular word is worth — see `isWeakTitleToken`.
 */
function matchTitleToken(query: TitleQuery, token: string): string | null {
  return query.tokens.find((t) => sameName(t, token)) ?? null;
}

/** matchTitleToken, plus the diminutive table. Given names only — surnames never. */
function matchTitleTokenGiven(query: TitleQuery, given: string): string | null {
  const direct = matchTitleToken(query, given);
  if (direct !== null) {
    return direct;
  }

  // The title may shorten a stored full name ("Ване" for a contact "Иван")...
  const alias = query.aliases.find((a) => sameName(a.full, given));
  if (alias !== undefined) {
    return alias.source;
  }

  // ...or the contact may be stored under the diminutive the office actually
  // uses ("Ваня") while the title spells it out.
  for (const full of expandDiminutive(given)) {
    const hit = matchTitleToken(query, full);
    if (hit !== null) {
      return hit;
    }
  }

  return null;
}

/**
 * How much of this contact's name the title mentions, and how good the evidence is.
 *
 * `score` counts distinct parts of the name, which is load-bearing: a contact
 * stored as "Иван Иван" must not outscore "Иван Петров" on one word of title.
 *
 * `strong` counts only the parts matched by a title word that can stand on its
 * own — i.e. not a common noun and not two letters long. A candidate with no
 * strong evidence and only one matched part is a coincidence, not a suggestion.
 */
type CandidateScore = {
  score: number;
  strong: number;
};

function scoreCandidate(query: TitleQuery, candidate: NameCandidate): CandidateScore {
  const given = [...new Set(nameTokens(candidate.first_name))];
  const family = [...new Set(nameTokens(candidate.last_name))].filter((t) => !given.includes(t));

  let score = 0;
  let strong = 0;

  const count = (hit: string | null): void => {
    if (hit === null) {
      return;
    }
    score += 1;
    if (!isWeakTitleToken(hit)) {
      strong += 1;
    }
  };

  for (const token of given) {
    count(matchTitleTokenGiven(query, token));
  }

  for (const token of family) {
    count(matchTitleToken(query, token));
  }

  return { score, strong };
}

/**
 * The single contact a task title is about, or null.
 *
 * Null covers both "nobody matched" and "more than one matched equally well",
 * and the two are deliberately the same answer. The caller has no way to
 * present a tie, and two contacts scoring alike is the normal shape of a title
 * that names only a first name ("Позвонить Ивану" with two Иваны on file) or
 * only a surname shared by a couple ("Позвонить Ивановой"). Guessing between
 * them attaches the wrong person to the task.
 *
 * A strictly-better score wins outright; matching more parts of a name is a
 * real signal, so "Иван Петров" beats "Иван Сидоров" for "позвонить ивану
 * петрову" without any tie-break heuristics.
 */
export function matchContactByName<T extends NameCandidate>(
  title: string,
  candidates: readonly T[],
): T | null {
  const query = buildTitleQuery(title);
  if (query.tokens.length === 0 || candidates.length === 0) {
    return null;
  }

  let best: T | null = null;
  let bestScore = 0;
  let tied = false;

  for (const candidate of candidates) {
    const { score, strong } = scoreCandidate(query, candidate);
    if (score === 0) {
      continue;
    }

    // Weak evidence needs corroboration. One common-noun word ("роман") or one
    // two-letter word ("ли") cannot pick a person; it counts perfectly well once
    // some other part of the same name also matched.
    if (strong === 0 && score < 2) {
      continue;
    }

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }

  return tied ? null : best;
}
