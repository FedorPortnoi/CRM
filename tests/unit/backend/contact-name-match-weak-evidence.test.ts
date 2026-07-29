import { describe, expect, it } from 'vitest';

import { matchContactByName } from '../../../backend/services/contact-name-match';

// ---------------------------------------------------------------------------
// The weak-evidence rule in backend/services/contact-name-match.ts
//
// Replacing the model on POST /tasks/suggest-contact removed the one thing that
// understood context. Several ordinary Russian given names are also common
// nouns, so a pure token matcher answers "Написать роман" with a contact named
// Роман — the wrong-person-attached-to-a-task outcome the controller's strict
// UUID parsing exists to avoid.
//
// The rule: a title word that is a common noun, or is only two letters, is WEAK.
// It can confirm a contact the title names some other way, but it cannot pick
// one on its own. These tests pin BOTH directions — that the coincidences are
// refused, and that the real matches still land. A fix that only did the first
// would be easy and would gut the feature.
// ---------------------------------------------------------------------------

const CONTACTS = [
  { id: 'c-roman', first_name: 'Роман', last_name: 'Ковалёв' },
  { id: 'c-vera', first_name: 'Вера', last_name: 'Никитина' },
  { id: 'c-nadezhda', first_name: 'Надежда', last_name: 'Егорова' },
  { id: 'c-svetlana', first_name: 'Светлана', last_name: 'Рогова' },
  { id: 'c-vyacheslav', first_name: 'Вячеслав', last_name: 'Гринёв' },
  { id: 'c-li', first_name: 'Сергей', last_name: 'Ли' },
  { id: 'c-petrov', first_name: 'Иван', last_name: 'Петров' },
];

describe('contact-name-match weak evidence', () => {
  describe('a common noun alone suggests nobody', () => {
    // Every one of these was reproduced against the matcher before the rule
    // existed, and every one returned the contact named in the comment.
    const coincidences: ReadonlyArray<readonly [string, string]> = [
      ['Написать роман', 'Роман Ковалёв'],
      ['Согласовать роман договора', 'Роман Ковалёв'],
      ['Проверить веру клиента в продукт', 'Вера Никитина'],
      ['Обновить надежду на продление', 'Надежда Егорова'],
      ['Проверить настройки света в шоуруме', 'Светлана Рогова (via "света")'],
      ['Слава богу закрыли квартал', 'Вячеслав Гринёв (via "слава")'],
    ];

    for (const [title, wouldHaveMatched] of coincidences) {
      it(`«${title}» → null (was ${wouldHaveMatched})`, () => {
        expect(matchContactByName(title, CONTACTS)).toBeNull();
      });
    }
  });

  describe('a two-letter word alone suggests nobody', () => {
    // «ли» is a question particle AND a real surname. MIN_TOKEN_CHARS = 2 admits
    // it, and the comment claiming one-letter tokens are the only function words
    // was wrong about two-letter ones.
    it('«Проверить, оплатил ли клиент» → null (was Сергей Ли)', () => {
      expect(matchContactByName('Проверить, оплатил ли клиент', CONTACTS)).toBeNull();
    });

    it('«Уточнить, готов ли договор» → null (was Сергей Ли)', () => {
      expect(matchContactByName('Уточнить, готов ли договор', CONTACTS)).toBeNull();
    });
  });

  describe('corroborated, the same words still match', () => {
    // This is the half that stops the rule being a blunt stop-list. The weak
    // word is not banned — it just needs a second part of the same name.
    it('«Написать роман Ковалёву» still finds Роман Ковалёв', () => {
      expect(matchContactByName('Написать роман Ковалёву', CONTACTS)?.id).toBe('c-roman');
    });

    it('«Позвонить Сергею Ли» still finds the surname Ли', () => {
      expect(matchContactByName('Позвонить Сергею Ли', CONTACTS)?.id).toBe('c-li');
    });

    it('«Встреча с Верой Никитиной» still finds Вера Никитина', () => {
      expect(matchContactByName('Встреча с Верой Никитиной', CONTACTS)?.id).toBe('c-vera');
    });
  });

  describe('ordinary names are untouched by the rule', () => {
    // Дмитрий, Иван and Петров are not nouns, so a single mention still decides.
    // If this regresses, the rule has been applied far too widely.
    it('«Позвонить Ивану Петрову» finds Иван Петров', () => {
      expect(matchContactByName('Позвонить Ивану Петрову', CONTACTS)?.id).toBe('c-petrov');
    });

    it('a surname alone still decides when it is unambiguous', () => {
      expect(matchContactByName('Отправить счёт Петрову', CONTACTS)?.id).toBe('c-petrov');
    });

    it('a given name alone still decides when only one contact has it', () => {
      expect(matchContactByName('Позвонить Вячеславу', CONTACTS)?.id).toBe('c-vyacheslav');
    });
  });
});
