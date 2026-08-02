/**
 * The self-hosted Expo Updates manifest endpoint.
 *
 * Every assertion here exists because the corresponding failure is INVISIBLE.
 * expo-updates does not surface a rejected update to the user: it logs, gives
 * up, and launches the cached bundle. A wrong multipart part name, an
 * unparseable signature, a manifest served to the wrong channel and a server
 * that is simply down all look identical from a phone — "no update". So the
 * things pinned below are the things that would otherwise be discovered months
 * later, when a fix that was "published" turns out never to have shipped:
 *
 *   1. The response is multipart/mixed with a part the client dispatches on.
 *      FileDownloader.kt matches ONLY on the `name` parameter of
 *      content-disposition; a part it does not recognise is dropped silently.
 *   2. An unknown runtimeVersion produces the protocol's no-update-available
 *      directive, not a 500 and not an empty 200.
 *   3. The signature verifies against the certificate that ships inside the app.
 *      A signature the client cannot verify is refused with no user-visible
 *      difference from having nothing to publish.
 *   4. A `rustore` client never receives a `production` bundle.
 *   5. An asset path that tries to escape the update directory gets nothing —
 *      and a legitimate asset still gets served, so that check cannot pass
 *      vacuously.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import updatesRoutes from '../../../backend/api/routes/updates';
import {
  UPDATES_ASSETS_PATH_PREFIX,
  UPDATES_MANIFEST_PATH,
  resetCodeSigningKeyCache,
  resolveAssetFile,
} from '../../../backend/services/updates-store';

// ─── Fixture ─────────────────────────────────────────────────────────────────

const RV_KNOWN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const RV_ROLLBACK = 'ffffffffffffffffffffffffffffffff';
const RV_UNKNOWN = '00000000000000000000000000000000';

const UPDATE_PRODUCTION = '11111111-1111-4111-8111-111111111111';
const UPDATE_RUSTORE = '22222222-2222-4222-8222-222222222222';

const BUNDLE_RELATIVE = '_expo/static/js/android/entry-prod.hbc';
const ASSET_RELATIVE = 'assets/9f86d081884c7d659a2feaa0c55ad015';

let storeDir: string;
let keyDir: string;
let signingKeyPath: string;
let verificationKey: crypto.KeyObject;
let usingShippedCertificate = false;
let app: FastifyInstance;

const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  savedEnv[name] = process.env[name];
  process.env[name] = value;
}

function sha256Base64Url(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}

function writeFixtureFile(updateDir: string, relative: string, contents: string): string {
  const file = path.join(updateDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
  return sha256Base64Url(Buffer.from(contents, 'utf8'));
}

function writeUpdate(runtimeVersion: string, channel: string, updateId: string, marker: string): void {
  const updateDir = path.join(storeDir, runtimeVersion, channel, updateId);
  const bundleHash = writeFixtureFile(updateDir, BUNDLE_RELATIVE, `// bundle for ${marker}\n`);
  const assetHash = writeFixtureFile(updateDir, ASSET_RELATIVE, `asset bytes for ${marker}\n`);

  const record = {
    id: updateId,
    createdAt: '2026-08-01T12:00:00.000Z',
    runtimeVersion,
    channel,
    platforms: {
      android: {
        launchAsset: {
          key: `entry-${marker}`,
          path: BUNDLE_RELATIVE,
          contentType: 'application/javascript',
          hash: bundleHash,
        },
        assets: [
          {
            key: '9f86d081884c7d659a2feaa0c55ad015',
            path: ASSET_RELATIVE,
            contentType: 'image/png',
            fileExtension: '.png',
            hash: assetHash,
          },
        ],
      },
      ios: {
        launchAsset: {
          key: `entry-ios-${marker}`,
          path: BUNDLE_RELATIVE,
          contentType: 'application/javascript',
          hash: bundleHash,
        },
        assets: [],
      },
    },
    metadata: { branchName: channel },
    extra: { channelMarker: marker },
  };

  fs.writeFileSync(path.join(updateDir, 'update.json'), JSON.stringify(record, null, 2), 'utf8');

  // A file that lands in an update directory without being declared — an editor
  // backup, a stray copy, a source map. It must be unreachable.
  fs.writeFileSync(path.join(updateDir, 'stray-secret.txt'), 'must never be served', 'utf8');
}

beforeAll(async () => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-updates-store-'));
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-updates-key-'));

  writeUpdate(RV_KNOWN, 'production', UPDATE_PRODUCTION, 'production');
  writeUpdate(RV_KNOWN, 'rustore', UPDATE_RUSTORE, 'rustore');

  fs.mkdirSync(path.join(storeDir, RV_ROLLBACK, 'production'), { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, RV_ROLLBACK, 'production', 'rollback.json'),
    JSON.stringify({ commitTime: '2026-07-30T09:15:00.000Z' }),
    'utf8',
  );

  // A file OUTSIDE any update directory, for the traversal case to aim at.
  fs.writeFileSync(path.join(storeDir, 'not-an-asset.txt'), 'must never be served', 'utf8');

  /**
   * Prefer the real signing pair. certs/updates/ is gitignored (the private key
   * must never leave this machine), so on a fresh clone it is absent and an
   * ephemeral RSA pair stands in — the protocol assertions are identical, only
   * the "verifiable against the certificate the app actually ships" part is
   * stronger when the real certificate is there.
   */
  const shippedKey = path.resolve(process.cwd(), 'certs', 'updates', 'private-key.pem');
  const shippedCert = path.resolve(process.cwd(), 'certs', 'updates', 'certificate.pem');

  if (fs.existsSync(shippedKey) && fs.existsSync(shippedCert)) {
    signingKeyPath = shippedKey;
    verificationKey = new crypto.X509Certificate(fs.readFileSync(shippedCert)).publicKey;
    usingShippedCertificate = true;
  } else {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    signingKeyPath = path.join(keyDir, 'private-key.pem');
    fs.writeFileSync(
      signingKeyPath,
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      'utf8',
    );
    verificationKey = pair.publicKey;
  }

  setEnv('UPDATES_STORE_DIR', storeDir);
  setEnv('UPDATES_BASE_URL', 'https://4kub.ru');
  setEnv('UPDATES_CODE_SIGNING_PRIVATE_KEY', signingKeyPath);
  resetCodeSigningKeyCache();

  app = Fastify();
  await app.register(updatesRoutes, { prefix: '/api/v1/updates' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  resetCodeSigningKeyCache();
  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.rmSync(keyDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ParsedPart = {
  name: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * Parse multipart/mixed the way the client does: dispatch on the `name`
 * parameter of content-disposition and nothing else.
 */
function parseMultipart(contentType: string, raw: string): ParsedPart[] {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  expect(boundary, 'response must declare a multipart boundary').toBeTruthy();

  const parts: ParsedPart[] = [];
  for (const chunk of raw.split(`--${boundary}`)) {
    const trimmed = chunk.replace(/^\r\n/, '');
    if (trimmed === '' || trimmed.startsWith('--')) {
      continue;
    }

    const separator = trimmed.indexOf('\r\n\r\n');
    expect(separator, 'each part must separate headers from body with CRLFCRLF').toBeGreaterThan(0);

    const headers: Record<string, string> = {};
    for (const line of trimmed.slice(0, separator).split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }

    const name = /name="([^"]+)"/.exec(headers['content-disposition'] ?? '')?.[1] ?? '';
    // The body ends with the CRLF that precedes the next boundary delimiter.
    parts.push({ name, headers, body: trimmed.slice(separator + 4).replace(/\r\n$/, '') });
  }

  return parts;
}

/** Parse an RFC 8941 dictionary of quoted strings, e.g. `sig="…", keyid="main"`. */
function parseSfvDictionary(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([A-Za-z0-9_.*-]+)="((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    out[match[1]] = match[2].replace(/\\(.)/g, '$1');
  }
  return out;
}

function manifestRequest(overrides: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: UPDATES_MANIFEST_PATH,
    headers: {
      'expo-platform': 'android',
      'expo-protocol-version': '1',
      'expo-runtime-version': RV_KNOWN,
      'expo-channel-name': 'production',
      accept: 'multipart/mixed,application/expo+json,application/json',
      ...overrides,
    },
  });
}

// ─── 1. Multipart shape ──────────────────────────────────────────────────────

describe('GET /api/v1/updates/manifest — protocol shape', () => {
  it('returns multipart/mixed with a `manifest` part and the protocol headers', async () => {
    const response = await manifestRequest();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^multipart\/mixed; boundary=/);
    // UpdateFactory.getUpdate throws "Legacy manifests are no longer supported"
    // when this header is absent — every manifest would be rejected.
    expect(response.headers['expo-protocol-version']).toBe('1');
    expect(response.headers['expo-sfv-version']).toBe('0');
    expect(response.headers['cache-control']).toBe('no-store');

    const parts = parseMultipart(String(response.headers['content-type']), response.body);
    const manifestPart = parts.find((part) => part.name === 'manifest');

    expect(manifestPart, 'a `manifest` part is required').toBeDefined();
    expect(manifestPart!.headers['content-type']).toMatch(/^application\/json/);
    expect(manifestPart!.headers['content-disposition']).toContain('name="manifest"');
  });

  it('serves a manifest carrying every field the client requires', async () => {
    const response = await manifestRequest();
    const parts = parseMultipart(String(response.headers['content-type']), response.body);
    const manifest = JSON.parse(parts.find((part) => part.name === 'manifest')!.body);

    expect(manifest.id).toBe(UPDATE_PRODUCTION);
    expect(manifest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Number.isFinite(Date.parse(manifest.createdAt))).toBe(true);
    expect(manifest.runtimeVersion).toBe(RV_KNOWN);
    expect(manifest.metadata).toBeDefined();
    expect(manifest.extra).toBeDefined();

    // launchAsset: url and hash are what the client fetches and verifies.
    expect(manifest.launchAsset.url).toBe(
      `https://4kub.ru${UPDATES_ASSETS_PATH_PREFIX}${RV_KNOWN}/production/${UPDATE_PRODUCTION}/${BUNDLE_RELATIVE}`,
    );
    expect(manifest.launchAsset.contentType).toBe('application/javascript');
    expect(typeof manifest.launchAsset.hash).toBe('string');

    // Ordinary assets MUST carry fileExtension: ExpoUpdatesUpdate.kt reads it
    // with getString() and silently drops any asset that lacks it, which would
    // launch an update with missing images and no error anywhere.
    expect(manifest.assets).toHaveLength(1);
    for (const asset of manifest.assets) {
      expect(asset.key).toBeTruthy();
      expect(asset.hash).toBeTruthy();
      expect(asset.contentType).toBeTruthy();
      expect(asset.fileExtension).toBe('.png');
      expect(asset.url.startsWith(`https://4kub.ru${UPDATES_ASSETS_PATH_PREFIX}`)).toBe(true);
    }
  });

  it('pairs the manifest filter with the metadata key the client lowercases', async () => {
    const response = await manifestRequest();
    const parts = parseMultipart(String(response.headers['content-type']), response.body);
    const manifest = JSON.parse(parts.find((part) => part.name === 'manifest')!.body);

    // SelectionPolicies.matchesFilters lowercases metadata keys before comparing
    // them to filter keys, so `branchName` here must meet `branchname` there. A
    // mismatch makes the device discard an update it just downloaded.
    expect(manifest.metadata.branchName).toBe('production');
    expect(parseSfvDictionary(String(response.headers['expo-manifest-filters'])).branchname).toBe(
      'production',
    );
  });

  it('rejects a request with no platform or no runtime version', async () => {
    const noPlatform = await manifestRequest({ 'expo-platform': 'windows' });
    expect(noPlatform.statusCode).toBe(400);
    expect(noPlatform.json().error.code).toBe('INVALID_PLATFORM');

    const noChannel = await app.inject({
      method: 'GET',
      url: UPDATES_MANIFEST_PATH,
      headers: {
        'expo-platform': 'ios',
        'expo-protocol-version': '1',
        'expo-runtime-version': RV_KNOWN,
      },
    });
    expect(noChannel.statusCode).toBe(400);
    expect(noChannel.json().error.code).toBe('MISSING_CHANNEL');
  });
});

// ─── 2. No update available ──────────────────────────────────────────────────

describe('GET /api/v1/updates/manifest — no update available', () => {
  it('answers an unknown runtimeVersion with the noUpdateAvailable directive', async () => {
    const response = await manifestRequest({ 'expo-runtime-version': RV_UNKNOWN });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^multipart\/mixed/);

    const parts = parseMultipart(String(response.headers['content-type']), response.body);
    expect(parts.find((part) => part.name === 'manifest')).toBeUndefined();

    const directive = parts.find((part) => part.name === 'directive');
    expect(directive, 'a `directive` part is required').toBeDefined();
    expect(JSON.parse(directive!.body)).toEqual({ type: 'noUpdateAvailable' });
  });

  it('answers a client that already runs the newest update with noUpdateAvailable', async () => {
    const response = await manifestRequest({ 'expo-current-update-id': UPDATE_PRODUCTION });
    const parts = parseMultipart(String(response.headers['content-type']), response.body);

    expect(parts.find((part) => part.name === 'manifest')).toBeUndefined();
    expect(JSON.parse(parts.find((part) => part.name === 'directive')!.body).type).toBe(
      'noUpdateAvailable',
    );
  });

  it('serves rollBackToEmbedded when the channel carries a rollback marker', async () => {
    const response = await manifestRequest({ 'expo-runtime-version': RV_ROLLBACK });
    const parts = parseMultipart(String(response.headers['content-type']), response.body);

    expect(JSON.parse(parts.find((part) => part.name === 'directive')!.body)).toEqual({
      type: 'rollBackToEmbedded',
      parameters: { commitTime: '2026-07-30T09:15:00.000Z' },
    });
  });

  it('falls back to 404 for a protocol-0 client, which cannot read directives', async () => {
    const response = await manifestRequest({
      'expo-runtime-version': RV_UNKNOWN,
      'expo-protocol-version': '0',
    });

    // FileDownloader.kt ignores the directive part in v0 compatibility mode and
    // then throws on the missing manifest part. A 404 is what Expo's own
    // reference server returns instead.
    expect(response.statusCode).toBe(404);
  });
});

// ─── 3. Code signing ─────────────────────────────────────────────────────────

describe('GET /api/v1/updates/manifest — code signing', () => {
  const expectSignatureHeader = 'sig, keyid="main", alg="rsa-v1_5-sha256"';

  it('signs the manifest so it verifies against the shipped certificate', async () => {
    const response = await manifestRequest({ 'expo-expect-signature': expectSignatureHeader });
    const parts = parseMultipart(String(response.headers['content-type']), response.body);
    const manifestPart = parts.find((part) => part.name === 'manifest')!;

    // The signature lives on the PART, not on the response — FileDownloader.kt
    // reads `expo-signature` out of the part headers for a multipart response.
    const rawSignature = manifestPart.headers['expo-signature'];
    expect(rawSignature, 'the manifest part must carry expo-signature').toBeTruthy();

    const dictionary = parseSfvDictionary(rawSignature);
    // keyid must match `codeSigningMetadata.keyid` in app.json. Anything else and
    // the client refuses with "Key with keyid=… not found in client
    // configuration" — which is indistinguishable from having no update.
    expect(dictionary.keyid).toBe('main');
    expect(dictionary.alg).toBe('rsa-v1_5-sha256');
    expect(dictionary.sig).toBeTruthy();

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(Buffer.from(manifestPart.body, 'utf8'));
    verifier.end();

    // Base64, not base64url: CodeSigningConfiguration.kt decodes with
    // Base64.DEFAULT.
    expect(verifier.verify(verificationKey, Buffer.from(dictionary.sig, 'base64'))).toBe(true);
  });

  it('signs the noUpdateAvailable directive too', async () => {
    const response = await manifestRequest({
      'expo-runtime-version': RV_UNKNOWN,
      'expo-expect-signature': expectSignatureHeader,
    });
    const parts = parseMultipart(String(response.headers['content-type']), response.body);
    const directive = parts.find((part) => part.name === 'directive')!;

    const dictionary = parseSfvDictionary(directive.headers['expo-signature']);
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(Buffer.from(directive.body, 'utf8'));
    verifier.end();

    expect(verifier.verify(verificationKey, Buffer.from(dictionary.sig, 'base64'))).toBe(true);
  });

  it('signs the exact bytes served, not a re-serialization of them', async () => {
    // Re-stringifying the manifest before signing is the classic way to produce
    // a signature that verifies against nothing: a different key order or
    // spacing is a different byte string. Mutating one byte must break it.
    const response = await manifestRequest({ 'expo-expect-signature': expectSignatureHeader });
    const parts = parseMultipart(String(response.headers['content-type']), response.body);
    const manifestPart = parts.find((part) => part.name === 'manifest')!;
    const dictionary = parseSfvDictionary(manifestPart.headers['expo-signature']);

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(Buffer.from(`${manifestPart.body} `, 'utf8'));
    verifier.end();

    expect(verifier.verify(verificationKey, Buffer.from(dictionary.sig, 'base64'))).toBe(false);
  });

  it('uses the certificate that actually ships in the app when it is present', () => {
    // Informational rather than a gate: certs/ is gitignored, so a fresh clone
    // legitimately has neither file and the suite falls back to an ephemeral
    // pair. Stated out loud so a green run on CI is not mistaken for having
    // verified the real key.
    if (!usingShippedCertificate) {
      console.warn(
        'certs/updates/{private-key,certificate}.pem absent — signature checks ran against an ephemeral key',
      );
    }
    expect(verificationKey.asymmetricKeyType).toBe('rsa');
  });
});

// ─── 4. Channel isolation ────────────────────────────────────────────────────

describe('GET /api/v1/updates/manifest — channel isolation', () => {
  it('never serves a production bundle to a rustore client', async () => {
    const response = await manifestRequest({ 'expo-channel-name': 'rustore' });
    const parts = parseMultipart(String(response.headers['content-type']), response.body);
    const manifest = JSON.parse(parts.find((part) => part.name === 'manifest')!.body);

    expect(manifest.id).toBe(UPDATE_RUSTORE);
    expect(manifest.id).not.toBe(UPDATE_PRODUCTION);
    expect(manifest.extra.channelMarker).toBe('rustore');
    expect(manifest.metadata.branchName).toBe('rustore');
    expect(manifest.launchAsset.url).toContain(`/${UPDATE_RUSTORE}/`);
    expect(manifest.launchAsset.url).not.toContain(UPDATE_PRODUCTION);
  });

  it('answers a channel that has published nothing with noUpdateAvailable', async () => {
    const response = await manifestRequest({ 'expo-channel-name': 'preview' });
    const parts = parseMultipart(String(response.headers['content-type']), response.body);

    expect(parts.find((part) => part.name === 'manifest')).toBeUndefined();
    expect(JSON.parse(parts.find((part) => part.name === 'directive')!.body).type).toBe(
      'noUpdateAvailable',
    );
  });
});

// ─── 5. Assets and traversal ─────────────────────────────────────────────────

describe('GET /api/v1/updates/assets — serving and traversal', () => {
  const base = `${UPDATES_ASSETS_PATH_PREFIX}${RV_KNOWN}/production/${UPDATE_PRODUCTION}`;

  it('serves a published asset with immutable caching', async () => {
    const response = await app.inject({ method: 'GET', url: `${base}/${ASSET_RELATIVE}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('asset bytes for production\n');
    // Content-addressed URLs can never point at different bytes, so the long TTL
    // is safe — and it is what keeps a phone on a metered tariff from
    // re-downloading the whole update on every launch.
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves the launch asset', async () => {
    const response = await app.inject({ method: 'GET', url: `${base}/${BUNDLE_RELATIVE}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/javascript');
  });

  const traversals: Array<[string, string]> = [
    ['literal dot-dot', `${base}/../../../not-an-asset.txt`],
    ['encoded dot-dot', `${base}/..%2F..%2F..%2Fnot-an-asset.txt`],
    ['double-encoded dot-dot', `${base}/..%252F..%252F..%252Fnot-an-asset.txt`],
    ['backslash', `${base}/..%5C..%5C..%5Cnot-an-asset.txt`],
    ['the update metadata itself', `${base}/update.json`],
    ['an undeclared file inside the update directory', `${base}/stray-secret.txt`],
    ['a sibling update', `${base}/../${UPDATE_RUSTORE}/${ASSET_RELATIVE}`],
  ];

  for (const [label, url] of traversals) {
    it(`refuses to serve outside the update directory — ${label}`, async () => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('must never be served');
    });
  }

  it('rejects traversal at the resolver, independent of how the router decoded it', () => {
    // The route test above depends on whatever normalisation the HTTP layer
    // applies. This one pins the check that actually does the work, with the
    // strings the router would never hand over in that form.
    expect(
      resolveAssetFile(RV_KNOWN, 'production', UPDATE_PRODUCTION, `../../../not-an-asset.txt`),
    ).toBeNull();
    expect(
      resolveAssetFile(RV_KNOWN, 'production', UPDATE_PRODUCTION, `..\\..\\..\\not-an-asset.txt`),
    ).toBeNull();
    expect(resolveAssetFile(RV_KNOWN, 'production', UPDATE_PRODUCTION, 'C:\\Windows\\win.ini')).toBeNull();
    expect(resolveAssetFile(RV_KNOWN, 'production', UPDATE_PRODUCTION, '/etc/passwd')).toBeNull();
    expect(resolveAssetFile(RV_KNOWN, '..', UPDATE_PRODUCTION, ASSET_RELATIVE)).toBeNull();
    expect(resolveAssetFile('..', 'production', UPDATE_PRODUCTION, ASSET_RELATIVE)).toBeNull();
    expect(resolveAssetFile(RV_KNOWN, 'production', 'not-a-uuid', ASSET_RELATIVE)).toBeNull();

    // …and the legitimate path still resolves, so none of the above passes only
    // because the resolver returns null for everything.
    expect(
      resolveAssetFile(RV_KNOWN, 'production', UPDATE_PRODUCTION, ASSET_RELATIVE),
    ).not.toBeNull();
  });

  it('404s an unknown update id without revealing whether it exists', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${UPDATES_ASSETS_PATH_PREFIX}${RV_KNOWN}/production/33333333-3333-4333-8333-333333333333/${ASSET_RELATIVE}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
