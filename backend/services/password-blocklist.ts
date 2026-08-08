/**
 * password-blocklist.ts
 *
 * An OFFLINE membership test for passwords, run at the tail of PasswordSchema so
 * every path that sets a password inherits it.
 *
 * ─── WHY A LIST AT ALL ──────────────────────────────────────────────────────
 *
 * The policy was length plus four character classes, and both user-facing
 * screens print that rule verbatim ("Минимум 8 символов: заглавная и строчная
 * буквы, цифра и специальный символ"). Told exactly what shape to produce, a
 * Russian office reaches for about ten strings, and `Password1!` is the first of
 * them — 10 characters, all four classes, accepted by register, invite-accept,
 * set-credentials and change-password alike. One candidate sprayed across
 * harvested addresses never trips the per-(ip,email) budget and never approaches
 * the ten-failure lockout, so the character-class rule was generating the guess
 * rather than preventing it.
 *
 * NO HaveIBeenPwned, NO network, NO US-fronted service — a hard project rule,
 * and correct here anyway: a password check that depends on someone else's
 * uptime is a password check that fails open on a bad day.
 *
 * ─── WHY THE LIST IS A .ts MODULE FIRST AND A .txt SECOND ───────────────────
 *
 * Production runs `dist/backend/index.js`, built by a bare `tsc -p
 * backend/tsconfig.json`, and tsc copies NO non-.ts files — `dist/backend/data/`
 * does not and will not exist. A readFileSync that throws on a missing file
 * would therefore turn the first `pm2 restart` after this lands into a boot
 * crash on the laptop that IS production, while every vitest run stayed green
 * because vitest reads the source tree. So:
 *
 *   • CORE_BLOCKLIST below is compiled by tsc and is ALWAYS present. It is the
 *     guarantee.
 *   • backend/data/password-blocklist.txt is an OPTIONAL, human-editable
 *     augmentation, resolved cwd-first exactly like readAppVersion() in
 *     backend/index.ts. Missing or unreadable is logged and ignored — never
 *     fatal, and never silently reducing the check to nothing, because the core
 *     list does not depend on it.
 *
 * ─── THE NORMALIZER ─────────────────────────────────────────────────────────
 *
 * Two candidate forms are derived from the input and BOTH are looked up, because
 * neither alone works: fold-only loses nothing but misses plain `Password123!`
 * once digits have been folded into letters, and strip-only misses `P@ssw0rd`.
 * Order matters and is easy to get backwards — folding `0→o`/`1→i` BEFORE
 * stripping a trailing digit run leaves nothing for the strip to remove, and
 * `Password1!` normalizes to "passwordii", which is on no list of real
 * passwords. Correct order is: fold SYMBOL leet → strip → drop trailing digits →
 * fold DIGIT leet.
 *
 * Cyrillic is KEPT, not stripped. Stripping it would make the пароль / парол /
 * йцукен entries permanently unmatchable dead weight, and it would collapse a
 * genuinely strong Russian passphrase like `Секретный1Пароль!` to "ii" — which
 * the repeated-character heuristic would then reject. The heuristics are
 * additionally gated on a minimum normalized length for the same reason.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Entries are stored ALREADY NORMALIZED, so the runtime does zero work per
 * entry. Curated rather than a vendored 10k dump: this is the set a Russian
 * office actually produces when handed this product's stated rule, plus the
 * international classics that any list would have. It is deliberately small
 * enough to read. See needs-owner note: dropping SecLists' top-10k into
 * backend/data/password-blocklist.txt widens it without touching this file.
 */
const CORE_BLOCKLIST: readonly string[] = [
  // The rule the UI prints, followed literally.
  'password', 'passw', 'passwd', 'pass', 'mypassword', 'newpassword', 'passwort',
  'qwerty', 'qwertyuiop', 'qwertyui', 'qwe', 'qweasd', 'qweasdzxc', 'qazwsx', 'qazwsxedc',
  'asdf', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'wasd',
  'admin', 'administrator', 'root', 'superuser', 'sysadmin', 'guest', 'user', 'test',
  'testing', 'demo', 'sample', 'example', 'default', 'changeme', 'letmein', 'welcome',
  'login', 'secret', 'access', 'master', 'manager', 'director', 'boss', 'office',
  'company', 'corporate', 'business', 'work', 'job', 'team', 'sales', 'crm',
  'monkey', 'dragon', 'shadow', 'sunshine', 'princess', 'football', 'baseball',
  'iloveyou', 'trustno', 'whatever', 'freedom', 'starwars', 'superman', 'batman',
  'pokemon', 'computer', 'internet', 'google', 'facebook', 'apple', 'samsung',
  'summer', 'winter', 'spring', 'autumn', 'january', 'february', 'december',
  'hello', 'helloworld', 'hallo', 'hey', 'hi',
  'love', 'lovely', 'lovers', 'family', 'friend', 'happy', 'money', 'cash',
  'phone', 'mobile', 'android', 'iphone', 'windows', 'linux', 'server',
  'letmein', 'openup', 'opensesame', 'nopassword', 'nothing', 'temp', 'temporary',
  'abcabc', 'abcdef', 'abcdefg', 'abcdefgh', 'aaaaaa', 'aaaaaaa', 'aaaaaaaa',
  'football', 'hockey', 'soccer', 'tennis', 'boxing',

  // Latin transliterations a Russian speaker reaches for. This half is what an
  // English wordlist does not have and what matters most in this deployment.
  'parol', 'parolparol', 'moiparol', 'novyparol', 'privet', 'privetvsem',
  'poka', 'spasibo', 'pozhaluysta', 'lyublyu', 'yalyublyu', 'yalyublyutebya',
  'lyubov', 'schaste', 'udacha', 'zdorove', 'krasota', 'solnce', 'solnyshko',
  'rossiya', 'russia', 'moskva', 'moscow', 'piter', 'peterburg', 'sanktpeterburg',
  'sibir', 'ural', 'kavkaz', 'volga', 'kreml', 'kremlin',
  'spartak', 'zenit', 'cska', 'lokomotiv', 'dinamo', 'rubin', 'krasnodar',
  'natasha', 'marina', 'sergey', 'andrey', 'aleksandr', 'alexandr', 'alex',
  'dmitry', 'dmitriy', 'nikolay', 'vladimir', 'mikhail', 'maksim', 'maxim',
  'ivan', 'ivanov', 'petrov', 'sidorov', 'petya', 'vasya', 'sasha', 'masha',
  'katya', 'lena', 'olga', 'irina', 'tatyana', 'svetlana', 'anna', 'elena',
  'yiukeng', 'ycuken', 'yzukeng', 'yfnfif', 'jhfrek',
  'rabota', 'firma', 'kompaniya', 'direktor', 'buhgalter', 'menedzher',
  'sekret', 'sekretno', 'vhod', 'dostup', 'klyuch',

  // Cyrillic, as typed. Reachable because the normalizer keeps Cyrillic.
  'пароль', 'парол', 'мойпароль', 'новыйпароль', 'привет', 'приветвсем',
  'спасибо', 'пожалуйста', 'люблю', 'ялюблютебя', 'любовь', 'счастье', 'удача',
  'россия', 'москва', 'питер', 'петербург', 'спартак', 'зенит', 'цска',
  'наташа', 'марина', 'сергей', 'андрей', 'александр', 'дмитрий', 'владимир',
  'михаил', 'максим', 'иван', 'иванов', 'петров', 'петя', 'вася', 'саша', 'маша',
  'катя', 'лена', 'ольга', 'ирина', 'татьяна', 'светлана', 'анна', 'елена',
  'йцукен', 'йцукенг', 'фыва', 'фывапролд', 'ячсмить',
  'работа', 'фирма', 'компания', 'директор', 'бухгалтер', 'менеджер',
  'секрет', 'секретно', 'вход', 'доступ', 'ключ', 'солнышко', 'зайка', 'котик',

  // This product's own words — the first thing anyone types at a new CRM.
  'kub', 'kub4', 'chetyrekub', 'куб', 'кубкуб', 'crmcrm', 'crmpassword',
  'firmennyparol', '4kub',
] as const;

/**
 * Optional augmentation. One entry per line, `#` comments ignored; entries are
 * normalized on load so the file can be written in plain human form.
 */
const BLOCKLIST_FILE = join('backend', 'data', 'password-blocklist.txt');

function blocklistFileCandidates(): string[] {
  return [
    // cwd-first, matching readAppVersion() in backend/index.ts. pm2 runs from the
    // repo root, so this is the one that actually resolves in production.
    join(process.cwd(), BLOCKLIST_FILE),
    join(process.cwd(), 'data', 'password-blocklist.txt'),
    join(__dirname, '..', 'data', 'password-blocklist.txt'),
  ];
}

function loadAugmentation(): string[] {
  for (const candidate of blocklistFileCandidates()) {
    let raw: string;
    try {
      raw = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }

    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  // Not fatal. CORE_BLOCKLIST is compiled in and is the guarantee; the file is
  // an optional widening that the production build does not carry.
  // eslint-disable-next-line no-console
  console.warn(
    `[password-blocklist] optional ${BLOCKLIST_FILE} not found; using the ` +
    `${CORE_BLOCKLIST.length}-entry compiled list only.`,
  );
  return [];
}

const SYMBOL_LEET: Record<string, string> = { '@': 'a', $: 's', '(': 'c', '+': 't' };
const DIGIT_LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't',
};

const KEEP = /[a-z0-9а-яё]/;

/**
 * The two forms a password is looked up under. Exported so the client mirror and
 * the tests can assert they agree rather than each reimplementing the order.
 */
export function normalizeCandidates(value: string): string[] {
  const lowered = value.normalize('NFKC').toLowerCase();

  // Symbol leet BEFORE stripping — @ and $ carry information that stripping
  // would throw away.
  let symbolFolded = '';
  for (const char of lowered) {
    symbolFolded += SYMBOL_LEET[char] ?? char;
  }

  const strip = (input: string): string => {
    let out = '';
    for (const char of input) {
      if (KEEP.test(char)) out += char;
    }
    return out;
  };

  // Then strip, THEN drop a trailing digit run. Doing the digit fold first would
  // leave the strip nothing to remove — the bug this ordering exists to avoid.
  const plain = strip(symbolFolded).replace(/[0-9]+$/, '');

  let digitFolded = '';
  for (const char of plain) {
    digitFolded += DIGIT_LEET[char] ?? char;
  }

  return plain === digitFolded ? [plain] : [plain, digitFolded];
}

/** The primary form, used by the shape heuristics below. */
export function normalizePassword(value: string): string {
  return normalizeCandidates(value)[0] ?? '';
}

const BLOCKED: ReadonlySet<string> = new Set<string>([
  ...CORE_BLOCKLIST,
  ...loadAugmentation().flatMap((entry) => normalizeCandidates(entry)),
].filter((entry) => entry.length > 0));

/** Exposed so a test can assert the list actually loaded and is not empty. */
export function blocklistSize(): number {
  return BLOCKED.size;
}

/**
 * Compliant-but-trivial shapes a fixed list can never enumerate: one character
 * repeated, or a contiguous run up or down the alphabet or the digits.
 *
 * Gated on length so a SHORT normalized residue can never trip them. Without
 * that gate, any password whose letters are almost all Cyrillic-plus-symbols
 * could reduce to two or three characters and read as "repeated".
 */
const MIN_SHAPE_LENGTH = 6;

function isTrivialShape(normalized: string): boolean {
  if (normalized.length < MIN_SHAPE_LENGTH) return false;

  if (new Set(normalized).size === 1) return true;

  let ascending = true;
  let descending = true;
  for (let i = 1; i < normalized.length; i++) {
    const delta = normalized.charCodeAt(i) - normalized.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
  }
  return ascending || descending;
}

/** True when the password must be refused as too common or too trivial. */
export function isBlockedPassword(value: string): boolean {
  const candidates = normalizeCandidates(value);
  if (candidates.some((candidate) => BLOCKED.has(candidate))) return true;
  return isTrivialShape(candidates[0] ?? '');
}
