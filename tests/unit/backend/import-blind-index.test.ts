import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { blindIndex, encryptField, ENCRYPTED_FIELD_PREFIX } from '../../../backend/services/encryption';

// ---------------------------------------------------------------------------
// Every route that writes a contact must write the blind index too.
//
// Contact.email/phone/mobile are encrypted at rest with a fresh IV per call, so
// the ciphertext is not searchable. Every lookup by email or phone — dedup on
// import, contact-search.ts, the sync controller — matches on the *_bidx HMAC
// instead. A create that encrypts the value but omits the index produces a row
// that is permanently unfindable by the only identifiers it has.
//
// Five live create sites had exactly that shape:
//   api/controllers/imports.ts  telegramVerify / vcardImport / whatsappImport
//   services/importBitrix24.ts  contact import loop
//   services/contact-recognition.ts  business-card scan with create_contact
//
// WHY THESE TESTS ASSERT ON THE COLUMN AND NOT ON A SEARCH: the same bug was
// fixed in contact-import.ts and the whole suite stayed green when the fix was
// reverted, because the import tests find their rows with q=<first_name>, which
// resolves through the unencrypted first_name column and passes either way.
// So each assertion below reads the *_bidx value handed to Prisma directly and
// compares it to blindIndex(<plaintext>) — delete a `*_bidx:` line and the
// matching test goes red immediately.
//
// Each test also pins the ORDERING: the index must be derived from the
// plaintext, never from the encryptField() output. Ciphertext still contains
// digits and still hashes to *something*, so an inverted order fails silently
// in production — here it is caught by an explicit not-the-ciphertext-hash
// assertion.
// ---------------------------------------------------------------------------

const ORG = '44444444-4444-4444-8444-000000000001';
const USER = '44444444-4444-4444-8444-00000000000a';

// One number in its three written forms; blindIndex folds them onto 79991234567.
const PHONE_PLUS7 = '+7 (999) 123-45-67';
const PHONE_LEADING8 = '8 999 123 45 67';
const PHONE_BARE = '9991234567';
const EMAIL = 'Ivan.Petrov@Example.RU';

const dbMock = vi.hoisted(() => ({
  contact: { create: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
  pipeline: { findFirst: vi.fn() },
  deal: { create: vi.fn() },
}));

const telegramMock = vi.hoisted(() => ({
  tgSendCode: vi.fn(),
  tgVerifyAndPull: vi.fn(),
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));
// The real module loads the MTProto client at import time; this suite never
// talks to Telegram.
vi.mock('../../../backend/services/importTelegram', () => telegramMock);
vi.mock('../../../backend/services/workflows', () => ({ evaluateWorkflows: vi.fn() }));

const { ImportsController } = await import('../../../backend/api/controllers/imports');
const { importFromBitrix24 } = await import('../../../backend/services/importBitrix24');
const { scanBusinessCard } = await import('../../../backend/services/contact-recognition');

type CreateData = Record<string, unknown>;

/** The `data` payload of the nth db.contact.create() call. */
function createdData(index = 0): CreateData {
  expect(dbMock.contact.create.mock.calls.length).toBeGreaterThan(index);
  return (dbMock.contact.create.mock.calls[index][0] as { data: CreateData }).data;
}

interface ReplyStub {
  status(code: number): ReplyStub;
  send(payload: unknown): ReplyStub;
}

function makeRequest(body: unknown): FastifyRequest {
  return { body, user: { sub: USER, org_id: ORG } } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  const reply: ReplyStub = {
    status() {
      return reply;
    },
    send() {
      return reply;
    },
  };

  return reply as unknown as FastifyReply;
}

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.TOKEN_ENCRYPTION_KEY = 'd'.repeat(32);

  dbMock.contact.create.mockReset();
  dbMock.contact.create.mockImplementation(async ({ data }: { data: CreateData }) => ({
    id: 'contact-1',
    mobile: null,
    ...data,
  }));
  dbMock.user.findUnique.mockReset();
  dbMock.user.findUnique.mockResolvedValue({ preferences: {} });
  dbMock.user.update.mockReset();
  dbMock.user.update.mockResolvedValue({});
  telegramMock.tgVerifyAndPull.mockReset();
});

afterEach(() => {
  process.env = savedEnv;
  vi.unstubAllGlobals();
});

/**
 * The shared shape of every assertion here: the column holds the ciphertext,
 * the index holds the HMAC of the plaintext, and the two are not confused.
 */
function expectIndexed(
  data: CreateData,
  column: 'email' | 'phone' | 'mobile',
  plaintext: string,
): void {
  const stored = data[column];
  const index = data[`${column}_bidx`];

  // The value itself is still encrypted — this is not a test that gave up on encryption.
  expect(typeof stored).toBe('string');
  expect(stored as string).toMatch(new RegExp(`^${ENCRYPTED_FIELD_PREFIX}`));

  // The index is present, well-formed, and equals the hash of the PLAINTEXT.
  expect(index).toBe(blindIndex(plaintext, column));
  expect(index).toMatch(/^[0-9a-f]{64}$/);

  // …and specifically NOT the hash of what was written to the column. Ciphertext
  // survives blindIndex() (it has digits, it is a string), so this is the only
  // assertion that catches an inverted order of operations.
  expect(index).not.toBe(blindIndex(stored as string, column));
}

describe('POST /imports/telegram/verify writes phone_bidx', () => {
  it('indexes the imported phone from the plaintext', async () => {
    telegramMock.tgVerifyAndPull.mockResolvedValue({
      session: 'session-string',
      contacts: [{ first_name: 'Иван', last_name: 'Петров', phone: PHONE_PLUS7, username: 'ivan' }],
    });

    await ImportsController.telegramVerify(
      makeRequest({ phone: PHONE_PLUS7, code: '12345', phoneCodeHash: 'hash' }),
      makeReply(),
    );

    expectIndexed(createdData(), 'phone', PHONE_PLUS7);
  });

  it('leaves phone_bidx unset for a Telegram contact with no number', async () => {
    telegramMock.tgVerifyAndPull.mockResolvedValue({
      session: 'session-string',
      contacts: [{ first_name: 'Иван', last_name: 'Петров', phone: undefined, username: 'ivan' }],
    });

    await ImportsController.telegramVerify(
      makeRequest({ phone: PHONE_PLUS7, code: '12345', phoneCodeHash: 'hash' }),
      makeReply(),
    );

    const data = createdData();
    expect(data.phone).toBeUndefined();
    expect(data.phone_bidx).toBeUndefined();
  });
});

describe('POST /imports/vcard writes phone_bidx and email_bidx', () => {
  it('indexes both PII fields from their plaintext', async () => {
    await ImportsController.vcardImport(
      makeRequest({
        contacts: [{ first_name: 'Иван', last_name: 'Петров', phone: PHONE_LEADING8, email: EMAIL, company: 'Ромашка' }],
      }),
      makeReply(),
    );

    const data = createdData();
    expectIndexed(data, 'phone', PHONE_LEADING8);
    expectIndexed(data, 'email', EMAIL);
  });

  it('indexes only the field that was supplied', async () => {
    await ImportsController.vcardImport(
      makeRequest({ contacts: [{ first_name: 'Иван', email: EMAIL }] }),
      makeReply(),
    );

    const data = createdData();
    expectIndexed(data, 'email', EMAIL);
    expect(data.phone).toBeUndefined();
    expect(data.phone_bidx).toBeUndefined();
  });
});

describe('POST /imports/whatsapp writes phone_bidx', () => {
  it('indexes the exported number from the plaintext', async () => {
    await ImportsController.whatsappImport(
      makeRequest({ contacts: [{ name: 'Иван Петров', phone: PHONE_BARE, message_count: 12 }] }),
      makeReply(),
    );

    expectIndexed(createdData(), 'phone', PHONE_BARE);
  });
});

describe('importFromBitrix24 writes phone_bidx and email_bidx', () => {
  it('indexes both PII fields from the trimmed plaintext', async () => {
    // One page of one contact, then the generator stops (no `next`). No network:
    // fetch is stubbed, and the URL still has to satisfy the real SSRF allowlist.
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            ID: '1',
            NAME: ' Иван ',
            LAST_NAME: 'Петров',
            PHONE: [{ VALUE: ` ${PHONE_PLUS7} ` }],
            EMAIL: [{ VALUE: ` ${EMAIL} ` }],
            COMPANY_TITLE: 'Ромашка',
          },
        ],
        total: 1,
      }),
    });
    vi.stubGlobal('fetch', fetchStub);

    const result = await importFromBitrix24('https://demo.bitrix24.ru/rest/1/token', ORG, USER, false);
    expect(result.contacts_imported).toBe(1);

    // Trimmed before both operations, so column and index agree on one plaintext.
    const data = createdData();
    expectIndexed(data, 'phone', PHONE_PLUS7);
    expectIndexed(data, 'email', EMAIL);
  });
});

describe('business-card scan writes phone_bidx and email_bidx', () => {
  it('indexes the OCR-extracted contacts from the plaintext', async () => {
    const cardText = ['Иван Петров', 'ООО РОМАШКА', PHONE_PLUS7, 'ivan.petrov@example.com'].join('\n');

    const result = await scanBusinessCard(ORG, USER, { text: cardText, create_contact: true });

    // Guards the fixture: if the parser stops finding these, the assertions below
    // would be vacuously true against undefined values.
    expect(result.extracted.phone).toBe(PHONE_PLUS7);
    expect(result.extracted.email).toBe('ivan.petrov@example.com');

    const data = createdData();
    expectIndexed(data, 'phone', PHONE_PLUS7);
    expectIndexed(data, 'email', 'ivan.petrov@example.com');
  });

  it('writes nothing to the index columns when no contact is created', async () => {
    await scanBusinessCard(ORG, USER, { text: `Иван Петров\n${PHONE_PLUS7}`, create_contact: false });
    expect(dbMock.contact.create).not.toHaveBeenCalled();
  });

  it('does not hand the blind indexes back to the caller', async () => {
    // This is the only indexed write path that returns the created row, and its
    // route declares no response schema, so nothing downstream would drop them.
    // The index is deterministic across the whole deployment, so echoing one back
    // makes the endpoint an oracle: scan arbitrary text, read HMAC_k(number) for a
    // number you do not own, correlate contacts across organizations, never hold
    // the key. Adding the index write without this strip is what introduced it.
    const result = await scanBusinessCard(ORG, USER, {
      text: ['Иван Петров', PHONE_PLUS7, 'ivan.petrov@example.com'].join('\n'),
      create_contact: true,
    });

    // The write still carries the indexes — this is not a test that gave up on them.
    expectIndexed(createdData(), 'phone', PHONE_PLUS7);

    // The response does not. The mock echoes `data` back, so these would be
    // present if decryptScannedContact stopped stripping them.
    expect(result.contact).not.toBeNull();
    expect(result.contact).not.toHaveProperty('phone_bidx');
    expect(result.contact).not.toHaveProperty('email_bidx');
    expect(result.contact).not.toHaveProperty('mobile_bidx');

    // ...while the fields those indexes stand in for are still returned, decrypted.
    expect(result.contact?.phone).toBe(PHONE_PLUS7);
  });
});

describe('the indexes these routes write are the ones lookups compute', () => {
  it('gives a WhatsApp import and a vCard import the same index for one number', async () => {
    // The point of the index: the same person arriving through two importers,
    // written in two formats, collides on one hash and is dedup-able/searchable.
    await ImportsController.whatsappImport(
      makeRequest({ contacts: [{ name: 'Иван Петров', phone: PHONE_BARE }] }),
      makeReply(),
    );
    await ImportsController.vcardImport(
      makeRequest({ contacts: [{ first_name: 'Иван', phone: PHONE_PLUS7 }] }),
      makeReply(),
    );

    const whatsapp = createdData(0);
    const vcard = createdData(1);

    expect(whatsapp.phone_bidx).toBe(vcard.phone_bidx);
    // Different ciphertext for the same number — that is exactly why the index exists.
    expect(whatsapp.phone).not.toBe(vcard.phone);
    // And a lookup computed independently, the way contact-search.ts does it, hits them.
    expect(whatsapp.phone_bidx).toBe(blindIndex('+79991234567', 'phone'));
  });

  it('does not reuse the phone index for the mobile column', async () => {
    // Domain-separated keys: an importer that filed a number under phone must not
    // be findable through mobile_bidx, or the two columns stop meaning anything.
    await ImportsController.whatsappImport(
      makeRequest({ contacts: [{ name: 'Иван Петров', phone: PHONE_BARE }] }),
      makeReply(),
    );

    const data = createdData();
    expect(data.phone_bidx).toMatch(/^[0-9a-f]{64}$/);
    expect(data.phone_bidx).not.toBe(blindIndex(PHONE_BARE, 'mobile'));
    // None of these five routes accepts a mobile number at all.
    expect(data.mobile).toBeUndefined();
    expect(data.mobile_bidx).toBeUndefined();
  });
});

describe('encryptField is not applied twice on these paths', () => {
  it('keeps the stored value decryptable and the index computable from the source', async () => {
    await ImportsController.vcardImport(
      makeRequest({ contacts: [{ first_name: 'Иван', email: EMAIL, phone: PHONE_PLUS7 }] }),
      makeReply(),
    );

    const data = createdData();
    // encryptField() is a no-op on an already-encrypted value, so a double call
    // would be invisible here; what matters is that the index was taken before
    // any encryption happened, which is what these two comparisons show.
    expect(data.email_bidx).toBe(blindIndex(EMAIL, 'email'));
    expect(data.email_bidx).not.toBe(blindIndex(encryptField(EMAIL), 'email'));
    expect(data.phone_bidx).toBe(blindIndex(PHONE_PLUS7, 'phone'));
    expect(data.phone_bidx).not.toBe(blindIndex(encryptField(PHONE_PLUS7), 'phone'));
  });
});
