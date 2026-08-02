/**
 * Self-hosted Expo Updates endpoints — the HTTP half of the OTA channel.
 *
 *   GET /api/v1/updates/manifest                                   (public)
 *   GET /api/v1/updates/assets/:runtimeVersion/:channel/:updateId/* (public)
 *
 * BOTH ROUTES MUST BE ON THE PUBLIC ALLOWLIST in backend/api/authenticate.ts.
 * expo-updates fetches the manifest during native startup — before any JS has
 * run, before the user has logged in, and with no token it could possibly
 * present. Until those entries exist every launch gets a 401, which the client
 * reports as "failed to download remote update" and which looks exactly like
 * "there is no update" from the outside. The two exact strings to allowlist are
 * exported as UPDATES_MANIFEST_PATH and UPDATES_ASSETS_PATH_PREFIX from
 * backend/services/updates-store.ts, so the allowlist cannot drift from the
 * mount point.
 *
 * WHY SELF-HOSTED: see the header of backend/services/updates-store.ts. Short
 * version — ФЗ-242 plus the fact that Russian devices already cannot reliably
 * reach Google FCM, so a US CDN in the update path would reintroduce the exact
 * silent failure being engineered out of push.
 *
 * PROTOCOL: expo-updates v1, https://docs.expo.dev/technical-specs/expo-updates-1/
 * Every response shape below was checked against the client that ships in
 * node_modules/expo-updates (FileDownloader.kt, CodeSigningConfiguration.kt,
 * ExpoUpdatesUpdate.{kt,swift}, UpdateResponse.swift) rather than against the
 * prose alone, because the client is what accepts or refuses it.
 *
 * THE FAILURE MODE THAT DRIVES THIS FILE: a client that rejects a response —
 * bad signature, wrong keyid, missing manifest part, unparseable directive —
 * does not tell the user anything. It logs and launches the cached bundle. A
 * broken update server and a healthy one with nothing to publish are
 * indistinguishable from the outside, so every branch here either serves
 * something the client provably accepts or fails with a status code that shows
 * up in the server's own logs.
 */

import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  UpdatePlatform,
  buildManifest,
  buildMultipartBody,
  buildNoUpdateAvailableDirective,
  buildRollbackDirective,
  contentTypeForExtension,
  findLatestUpdate,
  findRollback,
  generateBoundary,
  getDefaultChannel,
  isSafePathSegment,
  parseExpectSignature,
  resolveAssetFile,
  serializeSfvDictionary,
  signBody,
} from '../../services/updates-store';

const EXPO_PROTOCOL_VERSION = '1';
const EXPO_SFV_VERSION = '0';

type AssetParams = {
  runtimeVersion?: string;
  channel?: string;
  updateId?: string;
  '*'?: string;
};

function readPositiveIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Unauthenticated endpoints get their own bucket, keyed by IP because there is
 * no account to key on.
 *
 * The ceiling is not tighter than this because of CGNAT: Russian mobile carriers
 * put very large numbers of subscribers behind a handful of addresses, and an
 * office NAT does the same. A limit sized for "one device" would throttle a
 * whole carrier at 09:00 when everyone opens the app — and, again, a throttled
 * update request is invisible to the user.
 *
 * `env` is a parameter rather than a read of the ambient process so a test can
 * exercise the PRODUCTION branch; NODE_ENV==='test' otherwise substitutes a
 * ceiling so high that asserting on it proves nothing. Same shape as
 * openTrackingRateLimit() in routes/tracking.ts, and for the same reason.
 */
export function updatesManifestRateLimit(
  env: NodeJS.ProcessEnv = process.env,
): { max: number; timeWindow: string } {
  return {
    max:
      env.NODE_ENV === 'test'
        ? 10_000
        : readPositiveIntEnv('UPDATES_MANIFEST_RATE_LIMIT_MAX', 120, env),
    timeWindow: '1 minute',
  };
}

/**
 * Higher than the manifest limit on purpose: one manifest fetch is followed by
 * one request per asset, and an update with a hundred images would otherwise
 * rate-limit itself halfway through and leave a half-downloaded update that the
 * client discards and re-fetches on the next launch, forever.
 */
export function updatesAssetRateLimit(
  env: NodeJS.ProcessEnv = process.env,
): { max: number; timeWindow: string } {
  return {
    max:
      env.NODE_ENV === 'test'
        ? 10_000
        : readPositiveIntEnv('UPDATES_ASSET_RATE_LIMIT_MAX', 1_200, env),
    timeWindow: '1 minute',
  };
}

function parsePlatform(raw: string | undefined): UpdatePlatform | null {
  return raw === 'ios' || raw === 'android' ? raw : null;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Headers every protocol-1 response carries.
 *
 * `expo-protocol-version` is not decoration: UpdateFactory.getUpdate throws
 * "Legacy manifests are no longer supported" when the response header is
 * absent, so omitting it rejects every manifest.
 *
 * cache-control is `no-store`. The spec recommends `private, max-age=0`; this is
 * the stricter of the two and matches the blanket rule the API already applies
 * to every /api/ response in backend/index.ts, so the two cannot disagree.
 */
function setCommonHeaders(reply: FastifyReply): void {
  reply.header('expo-protocol-version', EXPO_PROTOCOL_VERSION);
  reply.header('expo-sfv-version', EXPO_SFV_VERSION);
  reply.header('cache-control', 'no-store');
}

type SignedPart = { body: string; signature?: string };

/**
 * Sign a part body, or explain why the response must fail.
 *
 * When the client sent `expo-expect-signature` it has code signing configured
 * and WILL refuse an unsigned response ("No expo-signature header specified").
 * Serving one anyway would be a 200 that every device silently discards, so a
 * signing failure becomes a 500 that lands in this server's log instead.
 *
 * When the client did not ask, the part is still signed if the key is readable —
 * costs one RSA operation and means a client whose expect header we failed to
 * parse is served correctly anyway.
 */
function signPart(
  body: string,
  expectsSignature: boolean,
  request: FastifyRequest,
): SignedPart | 'signing-failed' {
  try {
    return { body, signature: signBody(body) };
  } catch (err) {
    if (expectsSignature) {
      request.log.error(
        { err },
        'expo-updates: client expects a signed manifest but the code signing key could not be used',
      );
      return 'signing-failed';
    }

    request.log.warn({ err }, 'expo-updates: serving an unsigned response, code signing key unavailable');
    return { body };
  }
}

function sendMultipart(reply: FastifyReply, parts: Parameters<typeof buildMultipartBody>[1]): FastifyReply {
  const boundary = generateBoundary();
  const payload = buildMultipartBody(boundary, parts);

  return reply
    .status(200)
    .header('content-type', `multipart/mixed; boundary=${boundary}`)
    .header('content-length', String(payload.byteLength))
    .send(payload);
}

function signingFailure(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({
    error: { code: 'UPDATE_SIGNING_FAILED', message: 'Update manifest could not be signed' },
  });
}

/**
 * Answer "nothing for you" in the way this client understands.
 *
 * Protocol 1 has a directive for it, and it is SIGNED — a client with code
 * signing on must be able to verify that "no update" really came from us and was
 * not injected by whatever is between it and this server.
 *
 * A protocol-0 client has no directives at all (FileDownloader.kt ignores the
 * directive part in v0 compatibility mode and then throws on the missing
 * manifest part), so it gets a 404 instead — which is exactly what Expo's own
 * reference server returns when it has nothing to serve.
 */
function sendNoUpdateAvailable(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolVersion: number,
  expectsSignature: boolean,
): FastifyReply {
  if (protocolVersion < 1) {
    return reply.status(404).send({
      error: { code: 'NO_UPDATE_AVAILABLE', message: 'No update available' },
    });
  }

  const body = JSON.stringify(buildNoUpdateAvailableDirective());
  const signed = signPart(body, expectsSignature, request);
  if (signed === 'signing-failed') {
    return signingFailure(reply);
  }

  return sendMultipart(reply, [
    {
      name: 'directive',
      contentType: 'application/json; charset=utf-8',
      body: signed.body,
      signature: signed.signature,
    },
  ]);
}

async function manifestHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  setCommonHeaders(reply);

  const protocolVersion = Number.parseInt(headerValue(request, 'expo-protocol-version') ?? '0', 10);
  const normalizedProtocol = Number.isFinite(protocolVersion) ? protocolVersion : 0;
  const expectSignature = parseExpectSignature(headerValue(request, 'expo-expect-signature'));
  const expectsSignature = expectSignature !== null;

  const platform = parsePlatform(headerValue(request, 'expo-platform'));
  if (!platform) {
    // A 400 rather than a silent no-update: no real client omits this, so a
    // request without it is a misconfiguration or a probe, and either is worth
    // seeing in the log.
    return reply.status(400).send({
      error: { code: 'INVALID_PLATFORM', message: 'expo-platform must be "ios" or "android"' },
    });
  }

  const runtimeVersion = headerValue(request, 'expo-runtime-version');
  if (!runtimeVersion) {
    return reply.status(400).send({
      error: { code: 'MISSING_RUNTIME_VERSION', message: 'expo-runtime-version header is required' },
    });
  }

  // No channel means no isolation, and the whole point of channels here is that
  // a RuStore build never receives a bundle published for the Play/production
  // channel. Guessing a default would defeat that on the one request where it
  // matters, so an unset UPDATES_DEFAULT_CHANNEL makes the header mandatory.
  // EAS Build writes it into the native config from eas.json, so a build that
  // reaches here without one was not built by the release pipeline.
  const channel = headerValue(request, 'expo-channel-name') ?? getDefaultChannel();
  if (!channel) {
    return reply.status(400).send({
      error: { code: 'MISSING_CHANNEL', message: 'expo-channel-name header is required' },
    });
  }

  // An unsafe segment cannot name anything in the store, so it is answered
  // identically to an unknown runtime version. Returning a distinct error would
  // turn this into an oracle for what the store contains.
  if (!isSafePathSegment(runtimeVersion) || !isSafePathSegment(channel)) {
    return sendNoUpdateAvailable(request, reply, normalizedProtocol, expectsSignature);
  }

  // A rollback outranks anything published beside it. It exists precisely for
  // the case where the newest publish is the broken thing, so it must not be
  // possible for that publish to win.
  const rollback = findRollback(runtimeVersion, channel);
  if (rollback) {
    if (normalizedProtocol < 1) {
      return reply.status(404).send({
        error: { code: 'NO_UPDATE_AVAILABLE', message: 'No update available' },
      });
    }

    const body = JSON.stringify(buildRollbackDirective(rollback.commitTime));
    const signed = signPart(body, expectsSignature, request);
    if (signed === 'signing-failed') {
      return signingFailure(reply);
    }

    return sendMultipart(reply, [
      {
        name: 'directive',
        contentType: 'application/json; charset=utf-8',
        body: signed.body,
        signature: signed.signature,
      },
    ]);
  }

  const update = findLatestUpdate(runtimeVersion, channel, platform);
  if (!update) {
    return sendNoUpdateAvailable(request, reply, normalizedProtocol, expectsSignature);
  }

  // The client already runs this update. Saying so costs one small response
  // instead of a manifest the client would parse, compare and throw away.
  const currentUpdateId = headerValue(request, 'expo-current-update-id');
  if (currentUpdateId && currentUpdateId.toLowerCase() === update.id.toLowerCase()) {
    return sendNoUpdateAvailable(request, reply, normalizedProtocol, expectsSignature);
  }

  const manifest = buildManifest(update, channel, platform);
  if (!manifest) {
    return sendNoUpdateAvailable(request, reply, normalizedProtocol, expectsSignature);
  }

  // Serialize ONCE. The signature covers these exact bytes; re-stringifying for
  // the body would risk a different key order and a signature that verifies
  // against nothing — which the client reports as, once again, no update.
  const body = JSON.stringify(manifest);
  const signed = signPart(body, expectsSignature, request);
  if (signed === 'signing-failed') {
    return signingFailure(reply);
  }

  // Pairs with `metadata.branchName` in the manifest. SelectionPolicies compares
  // filter keys against LOWERCASED metadata keys, so the filter key is
  // `branchname`; a stored update from another channel then loses to this filter
  // on the device as well as on the server.
  reply.header('expo-manifest-filters', serializeSfvDictionary({ branchname: channel }));

  return sendMultipart(reply, [
    {
      name: 'manifest',
      contentType: 'application/json; charset=utf-8',
      body: signed.body,
      signature: signed.signature,
    },
  ]);
}

/**
 * Serve one file out of an update directory.
 *
 * Assets are content-addressed by `expo export` (the filename IS the hash), so
 * the URL can never point at different bytes later — hence the immutable cache
 * headers. Those headers are set in an onSend hook rather than in the handler
 * because backend/index.ts installs a root onSend that stamps
 * `Cache-Control: no-store` on every /api/ response; a header set in the handler
 * loses to it. Fastify runs an encapsulated route's hooks AFTER the instance
 * hooks it inherited, so this one wins — and getting it wrong is not a
 * correctness bug, only a re-download-everything-every-launch bug, which is the
 * kind that goes unnoticed on a desk and hurts on a mobile tariff.
 */
async function assetHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const params = request.params as AssetParams;
  const relativePath = params['*'] ?? '';

  const file =
    params.runtimeVersion && params.channel && params.updateId && relativePath
      ? resolveAssetFile(params.runtimeVersion, params.channel, params.updateId, relativePath)
      : null;

  if (!file) {
    // One indistinguishable answer for "not found", "traversal attempt",
    // "malformed encoding" and "that is a directory". Anything more specific
    // tells a stranger what the store contains.
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Asset not found' },
    });
  }

  // Re-stat rather than trusting the resolver's: the file could have been
  // removed between the two calls by a cleanup of old updates. Same 404 as any
  // other miss — never a 500 with a filesystem path in it.
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Asset not found' },
    });
  }

  return reply
    .status(200)
    .header('content-type', contentTypeForExtension(extname(file)))
    .header('content-length', String(size))
    .header('x-content-type-options', 'nosniff')
    .send(createReadStream(file));
}

export default async function updatesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/manifest',
    { config: { rateLimit: updatesManifestRateLimit() } },
    manifestHandler,
  );

  fastify.get(
    '/assets/:runtimeVersion/:channel/:updateId/*',
    {
      config: { rateLimit: updatesAssetRateLimit() },
      onSend: async (_request, reply, payload) => {
        if (reply.statusCode === 200) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
          reply.removeHeader('pragma');
        }
        return payload;
      },
    },
    assetHandler,
  );
}

export const UpdatesRouteHandlers = { manifestHandler, assetHandler };
