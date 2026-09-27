/**
 * Local-disk attachment storage (LOCAL_STORAGE_DIR): the driver in
 * services/storage.ts and the upload/download routes in api/routes/files.ts.
 *
 * The contract under test is the one the app already speaks to S3: upload-url
 * hands back {upload_url, fields, file_url}; a multipart POST of those fields
 * ahead of the file stores it; file_url then serves it. And the S3 guarantees
 * carry over: a policy is single-key and expires, a key cannot escape its org,
 * and nothing is served that no attachment row references.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-00000000000b';

let attachments: Array<{ organization_id: string; file_url: string; filename: string; mime_type: string | null; size: number | null }> = [];

vi.mock('../../../backend/services/db', () => ({
  db: {
    attachment: {
      findFirst: vi.fn(async ({ where }: { where: { organization_id: string; file_url: string } }) =>
        attachments.find((a) => a.organization_id === where.organization_id && a.file_url === where.file_url) ?? null),
    },
  },
}));

let dir: string;
let app: FastifyInstance;
let storage: typeof import('../../../backend/services/storage');

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kub-files-'));
  process.env.LOCAL_STORAGE_DIR = dir;
  process.env.PUBLIC_APP_URL = 'https://4kub.test';
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
  process.env.MAX_UPLOAD_SIZE_MB = '1';
  storage = await import('../../../backend/services/storage');
  const { filesRoutes } = await import('../../../backend/api/routes/files');
  app = Fastify();
  await app.register(filesRoutes, { prefix: '/api/files' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  attachments = [];
});

function multipartBody(fields: Record<string, string>, file: Buffer, mime: string) {
  const boundary = '----kubtest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\nContent-Type: ${mime}\r\n\r\n`,
  ));
  parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function mint(mime = 'application/pdf') {
  return storage.generateUploadUrl(ORG, 'deal', 'Договор.pdf', mime, 1024 * 1024);
}

describe('local storage driver', () => {
  it('mints an upload aimed at the API, and a file_url the org owns', async () => {
    const u = await mint();
    expect(u.uploadUrl).toBe('https://4kub.test/api/files/upload');
    expect(u.fileUrl).toBe(`https://4kub.test/api/files/${u.key}`);
    expect(u.fields.key).toBe(u.key);
    expect(storage.deriveOrgScopedKey(u.fileUrl, ORG)).toBe(u.key);
    expect(storage.deriveOrgScopedKey(u.fileUrl, OTHER_ORG)).toBeNull();
  });

  it('rejects a tampered, foreign or expired policy', async () => {
    const u = await mint();
    expect(storage.verifyUploadPolicy(u.fields.policy)).not.toBeNull();
    const [body, sig] = u.fields.policy.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), max: 1e12 }))
      .toString('base64url');
    expect(storage.verifyUploadPolicy(`${forged}.${sig}`)).toBeNull();
    expect(storage.verifyUploadPolicy(u.fields.policy, Date.now() + 10 * 60_000)).toBeNull();
  });

  it('never maps a key outside the storage root', () => {
    expect(storage.isValidLocalKey(`uploads/${ORG}/deal/../../etc/passwd`)).toBe(false);
    expect(storage.isValidLocalKey(`uploads/${ORG}/deal/${ORG}-a/b`)).toBe(false);
    expect(() => storage.localPathForKey('uploads/../x')).toThrow();
  });
});

describe('files routes', () => {
  it('stores an upload, then serves it once an attachment references it', async () => {
    const u = await mint();
    const pdf = Buffer.from('%PDF-1.4 test');
    const res = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody(u.fields, pdf, 'application/pdf') });
    expect(res.statusCode).toBe(204);

    const path_ = u.fileUrl.replace('https://4kub.test', '');
    expect((await app.inject({ method: 'GET', url: path_ })).statusCode).toBe(404); // no row yet

    attachments.push({ organization_id: ORG, file_url: u.fileUrl, filename: 'Договор.pdf', mime_type: 'application/pdf', size: pdf.length });
    const got = await app.inject({ method: 'GET', url: path_ });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(pdf)).toBe(true);
    expect(got.headers['content-type']).toBe('application/pdf');
    expect(got.headers['content-disposition']).toContain("attachment; filename*=UTF-8''");
    expect(got.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses a second upload to the same key', async () => {
    const u = await mint();
    const first = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody(u.fields, Buffer.from('a'), 'application/pdf') });
    expect(first.statusCode).toBe(204);
    const again = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody(u.fields, Buffer.from('b'), 'application/pdf') });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    expect(fs.readFileSync(storage.localPathForKey(u.key), 'utf8')).toBe('a');
  });

  it('refuses a policy for another key or type, and an oversized file', async () => {
    const u = await mint();
    const other = await mint();
    const swapped = await app.inject({
      method: 'POST', url: '/api/files/upload',
      ...multipartBody({ ...u.fields, key: other.key }, Buffer.from('x'), 'application/pdf'),
    });
    expect(swapped.statusCode).toBe(403);
    const retyped = await app.inject({
      method: 'POST', url: '/api/files/upload',
      ...multipartBody({ ...u.fields, 'Content-Type': 'text/html' }, Buffer.from('x'), 'text/html'),
    });
    expect(retyped.statusCode).toBe(403);
    const big = await app.inject({
      method: 'POST', url: '/api/files/upload',
      ...multipartBody(u.fields, Buffer.alloc(1024 * 1024 + 10, 1), 'application/pdf'),
    });
    expect(big.statusCode).toBe(413);
    expect(fs.existsSync(storage.localPathForKey(u.key))).toBe(false);
  });
});
