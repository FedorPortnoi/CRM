/**
 * The client half of the password blocklist.
 *
 * ADVISORY ONLY. backend/services/password-blocklist.ts is the authority; this
 * exists so a user who types `Password1!` is told so in Russian, immediately,
 * instead of round-tripping to a 400.
 *
 * DELIBERATELY SHORTER than the backend list, and a .ts array rather than a
 * file: Metro does not bundle .txt, and the RN bundle should not grow by a
 * wordlist for a check the server repeats anyway. These are the entries a
 * Russian office actually produces from the rule the UI itself prints.
 *
 * The normalizer is COPIED by hand rather than imported. backend/ must never be
 * pulled into the app bundle, and the backend copy uses node:fs. It also must
 * not use Buffer — React Native ships no polyfill here and Buffer.byteLength
 * throws on device (see utf8ByteLength in ./password.ts for the same reason).
 * The two copies are kept honest by a parity test rather than by discipline.
 */

const SYMBOL_LEET: Record<string, string> = { '@': 'a', $: 's', '(': 'c', '+': 't' };
const DIGIT_LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't',
};

const KEEP = /[a-z0-9а-яё]/;

/**
 * Order is load-bearing and easy to get backwards: symbol leet BEFORE stripping
 * (or `@`/`$` are thrown away), digit leet AFTER dropping the trailing digit run
 * (or `Password1!` folds to "passwordii", which is on no list of real
 * passwords). Cyrillic is kept so `Пароль123!` is reachable and so a strong
 * Russian passphrase does not collapse to two characters.
 */
export function normalizeCandidates(value: string): string[] {
  const lowered = value.normalize('NFKC').toLowerCase();

  let symbolFolded = '';
  for (const char of lowered) {
    symbolFolded += SYMBOL_LEET[char] ?? char;
  }

  let stripped = '';
  for (const char of symbolFolded) {
    if (KEEP.test(char)) stripped += char;
  }

  const plain = stripped.replace(/[0-9]+$/, '');

  let digitFolded = '';
  for (const char of plain) {
    digitFolded += DIGIT_LEET[char] ?? char;
  }

  return plain === digitFolded ? [plain] : [plain, digitFolded];
}

const BLOCKED = new Set<string>([
  'password', 'passw', 'passwd', 'pass', 'mypassword', 'newpassword',
  'qwerty', 'qwertyuiop', 'qwertyui', 'qwe', 'qweasd', 'qazwsx',
  'asdf', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm',
  'admin', 'administrator', 'root', 'superuser', 'guest', 'user', 'test',
  'demo', 'default', 'changeme', 'letmein', 'welcome', 'login', 'secret',
  'master', 'manager', 'director', 'boss', 'office', 'company', 'work', 'crm',
  'monkey', 'dragon', 'shadow', 'sunshine', 'football', 'iloveyou',
  'computer', 'internet', 'google', 'apple', 'hello', 'love', 'money',
  'summer', 'winter', 'spring', 'autumn',
  'abcdef', 'abcdefg', 'abcdefgh', 'aaaaaa', 'aaaaaaa', 'aaaaaaaa',

  'parol', 'privet', 'spasibo', 'lyublyu', 'lyubov', 'schaste', 'udacha',
  'rossiya', 'moskva', 'piter', 'peterburg', 'spartak', 'zenit', 'cska',
  'natasha', 'marina', 'sergey', 'andrey', 'aleksandr', 'alex', 'dmitry',
  'vladimir', 'mikhail', 'maksim', 'ivan', 'ivanov', 'petrov', 'petya',
  'vasya', 'sasha', 'masha', 'katya', 'lena', 'olga', 'irina', 'anna', 'elena',
  'yiukeng', 'ycuken', 'rabota', 'firma', 'kompaniya', 'direktor', 'sekret',

  'пароль', 'парол', 'привет', 'спасибо', 'люблю', 'любовь', 'счастье',
  'россия', 'москва', 'питер', 'спартак', 'зенит', 'цска',
  'наташа', 'марина', 'сергей', 'андрей', 'александр', 'дмитрий', 'владимир',
  'михаил', 'максим', 'иван', 'иванов', 'петров', 'петя', 'вася', 'саша',
  'маша', 'катя', 'лена', 'ольга', 'ирина', 'анна', 'елена',
  'йцукен', 'йцукенг', 'фыва', 'фывапролд',
  'работа', 'фирма', 'компания', 'директор', 'секрет', 'солнышко',

  'kub', '4kub', 'куб',
]);

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

export function isCommonPassword(value: string): boolean {
  const candidates = normalizeCandidates(value);
  if (candidates.some((candidate) => BLOCKED.has(candidate))) return true;
  return isTrivialShape(candidates[0] ?? '');
}
