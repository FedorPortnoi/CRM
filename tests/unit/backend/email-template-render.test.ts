/**
 * The template renderer is the point where customer-supplied text (a contact's
 * name, company, notes) crosses into an HTML mail body and into the Subject:
 * header. These tests lock down the two properties that make that safe:
 * everything is escaped, and a placeholder that does not resolve stays visible
 * instead of silently vanishing.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../backend/services/db', () => ({ db: {} }));

import {
  buildTemplateValues,
  escapeHtml,
  extractTemplatePlaceholders,
  renderEmailTemplate,
  renderTemplateToHtml,
  renderTemplateToText,
  sanitizeHeaderValue,
  unknownTemplatePlaceholders,
} from '../../../backend/services/email-templates';

describe('escaping', () => {
  it('escapes every character that can break out of HTML', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapes a value substituted into HTML', () => {
    const rendered = renderTemplateToHtml('Hello {{first_name}}!', {
      first_name: '<script>alert(document.cookie)</script>',
    });

    expect(rendered.value).not.toContain('<script>');
    expect(rendered.value).toBe(
      'Hello &lt;script&gt;alert(document.cookie)&lt;/script&gt;!',
    );
  });

  it('escapes an img/onerror payload hidden in a company name', () => {
    const rendered = renderTemplateToHtml('{{company}} welcomes you', {
      company: '"><img src=x onerror=alert(1)>',
    });

    // The payload survives as inert text; what matters is that not a single
    // raw angle bracket or quote reaches the output, so it can never re-enter
    // markup.
    expect(rendered.value).not.toMatch(/[<>"']/);
    expect(rendered.value).toBe('&quot;&gt;&lt;img src=x onerror=alert(1)&gt; welcomes you');
  });

  it('escapes the template author\'s own markup too', () => {
    const rendered = renderTemplateToHtml('<b>bold</b> {{first_name}}', { first_name: 'Иван' });
    expect(rendered.value).toBe('&lt;b&gt;bold&lt;/b&gt; Иван');
  });

  it('turns newlines into <br /> only after escaping', () => {
    const rendered = renderTemplateToHtml('line1\nline2 {{first_name}}', {
      first_name: 'a\n<b>',
    });

    expect(rendered.value).toContain('<br />');
    expect(rendered.value).toContain('&lt;b&gt;');
    expect(rendered.value).not.toContain('<b>');
  });

  it('leaves the plain-text renderer unescaped — it is a separate function', () => {
    const rendered = renderTemplateToText('Hello {{first_name}}', { first_name: 'A & B' });
    expect(rendered.value).toBe('Hello A & B');
  });
});

describe('unresolved placeholders stay visible', () => {
  it('leaves an unknown key as its literal {{key}}', () => {
    const rendered = renderTemplateToText('Здравствуйте, {{frist_name}}!', { first_name: 'Иван' });

    expect(rendered.value).toBe('Здравствуйте, {{frist_name}}!');
    expect(rendered.value).not.toBe('Здравствуйте, !');
    expect(rendered.unresolved).toEqual(['frist_name']);
  });

  it('reports a key that resolved to an empty value instead of hiding it', () => {
    const rendered = renderTemplateToText('{{company}} sends regards', { company: '   ' });
    expect(rendered.blank).toEqual(['company']);
    expect(rendered.unresolved).toEqual([]);
  });

  it('does not resolve prototype keys', () => {
    const rendered = renderTemplateToText('{{constructor}} {{__proto__}} {{toString}}', {});
    expect(rendered.value).toBe('{{constructor}} {{__proto__}} {{toString}}');
    expect(rendered.unresolved).toEqual(['__proto__', 'constructor', 'toString']);
  });

  it('leaves malformed brace syntax alone', () => {
    const rendered = renderTemplateToText('{{ 1st name }} {single} {{}}', { first_name: 'x' });
    expect(rendered.value).toBe('{{ 1st name }} {single} {{}}');
    expect(rendered.unresolved).toEqual([]);
  });

  it('flags catalogue typos before the template is ever sent', () => {
    expect(
      unknownTemplatePlaceholders({ subject: 'Hi {{frist_name}}', body: '{{company}}' }),
    ).toEqual(['frist_name']);
    expect(extractTemplatePlaceholders('{{a}} {{b}}', '{{a}}')).toEqual(['a', 'b']);
  });
});

describe('subject rendering is header-safe', () => {
  it('folds CR/LF out of a substituted value', () => {
    const rendered = renderEmailTemplate(
      { subject: 'Offer for {{company}}', body: 'hi' },
      { company: 'Acme\r\nBcc: victim@example.ru' },
    );

    expect(rendered.subject).not.toContain('\r');
    expect(rendered.subject).not.toContain('\n');
    expect(rendered.subject).toBe('Offer for Acme Bcc: victim@example.ru');
  });

  it('drops control characters and Unicode line separators', () => {
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);

    expect(sanitizeHeaderValue(`a${NUL}b${BEL}c`)).toBe('a b c');
    expect(sanitizeHeaderValue(`a${LS}b${PS}c`)).toBe('a b c');
    expect(sanitizeHeaderValue('  spaced   out  ')).toBe('spaced out');
  });
});

describe('value building', () => {
  it('composes full_name and leaves absent fields unresolved rather than blank', () => {
    const values = buildTemplateValues({ first_name: 'Иван', last_name: 'Петров' });
    expect(values.full_name).toBe('Иван Петров');
    expect(values.company).toBeUndefined();

    const rendered = renderTemplateToText('{{full_name}} / {{company}}', values);
    expect(rendered.value).toBe('Иван Петров / {{company}}');
    expect(rendered.unresolved).toEqual(['company']);
  });

  it('accepts caller-supplied extras such as the unsubscribe link', () => {
    const values = buildTemplateValues(
      { first_name: 'Иван' },
      { unsubscribe_url: 'https://example.ru/u/abc', org_name: '4КУБ' },
    );

    const rendered = renderEmailTemplate(
      { subject: '{{org_name}}', body: '{{unsubscribe_url}}' },
      values,
    );
    expect(rendered.subject).toBe('4КУБ');
    expect(rendered.text).toBe('https://example.ru/u/abc');
    expect(rendered.unresolved).toEqual([]);
  });
});
