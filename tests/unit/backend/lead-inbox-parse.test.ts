import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The заявка email parser.
//
// Yandex does not document the notification format and has changed it before,
// so these fixtures pin the CONTRACT the poller depends on, not Yandex's
// exact bytes: labeled lines win, bare phone/email patterns are the fallback,
// unknown labels survive into the comment, and the raw text always comes back
// so a format change degrades to "unparsed but captured".
// ---------------------------------------------------------------------------

import {
  htmlToText,
  normalizeRuPhone,
  parseLeadEmail,
} from '../../../backend/services/lead-inbox-parse';

const YANDEX_STYLE_BODY = [
  'Здравствуйте!',
  'Вам поступила новая заявка с Яндекс Карт.',
  '',
  'Имя: Мария Иванова',
  'Телефон: +7 (912) 345-67-89',
  'Электронная почта: maria@example.ru',
  'Комментарий: Нужна консультация по продвижению кофейни',
  '',
  'Ответьте клиенту как можно скорее.',
].join('\n');

describe('parseLeadEmail', () => {
  it('reads the labeled Yandex-style body', () => {
    const parsed = parseLeadEmail({ subject: 'Новая заявка', text: YANDEX_STYLE_BODY });

    expect(parsed.name).toBe('Мария Иванова');
    expect(parsed.phone).toBe('+79123456789');
    expect(parsed.email).toBe('maria@example.ru');
    expect(parsed.comment).toBe('Нужна консультация по продвижению кофейни');
    expect(parsed.raw).toContain('заявка с Яндекс Карт');
  });

  it('canonicalizes an 8-prefixed phone to +7', () => {
    const parsed = parseLeadEmail({ text: 'Телефон: 8 912 345 67 89' });
    expect(parsed.phone).toBe('+79123456789');
  });

  it('falls back to a bare phone in free text and a name from the subject', () => {
    const parsed = parseLeadEmail({
      subject: 'Новая заявка от Ольга',
      text: 'Перезвоните мне пожалуйста 89123456789',
    });

    expect(parsed.phone).toBe('+79123456789');
    expect(parsed.name).toBe('Ольга');
  });

  it('parses an HTML-only notification', () => {
    const parsed = parseLeadEmail({
      html: '<div><p>Имя: Пётр</p><p>Телефон:&nbsp;+7 999 111-22-33</p></div>',
    });

    expect(parsed.name).toBe('Пётр');
    expect(parsed.phone).toBe('+79991112233');
  });

  it('keeps an unknown labeled answer instead of dropping it', () => {
    const parsed = parseLeadEmail({
      text: ['Имя: Иван', 'Бюджет: 50 000 рублей'].join('\n'),
    });

    expect(parsed.comment).toContain('бюджет: 50 000 рублей');
  });

  it('never mistakes the notification robot for the client', () => {
    const parsed = parseLeadEmail({
      text: 'Вы получили заявку. Не отвечайте на письмо noreply@business.yandex.ru напрямую.',
    });

    expect(parsed.email).toBeUndefined();
  });

  it('still finds a client who uses Yandex mail', () => {
    const parsed = parseLeadEmail({ text: 'Мой адрес ivan@yandex.ru, жду ответа' });
    expect(parsed.email).toBe('ivan@yandex.ru');
  });

  it('returns the raw text even when nothing parses', () => {
    const parsed = parseLeadEmail({ text: 'просто перезвоните' });

    expect(parsed.name).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
    expect(parsed.email).toBeUndefined();
    expect(parsed.raw).toBe('просто перезвоните');
  });
});

describe('normalizeRuPhone', () => {
  it.each([
    ['8 (912) 345-67-89', '+79123456789'],
    ['+7 912 345 67 89', '+79123456789'],
    ['9123456789', '+79123456789'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRuPhone(input)).toBe(expected);
  });

  it('leaves a short fragment alone', () => {
    expect(normalizeRuPhone('12345')).toBeUndefined();
  });
});

describe('htmlToText', () => {
  it('keeps labels on their own lines', () => {
    const text = htmlToText('<p>Имя: А</p><p>Телефон: Б</p>');
    expect(text).toContain('Имя: А\n');
    expect(text).toContain('Телефон: Б');
  });
});
