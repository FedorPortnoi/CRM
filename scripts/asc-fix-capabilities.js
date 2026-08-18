#!/usr/bin/env node
'use strict';
/**
 * Enable the Associated Domains capability on the 4КУБ App ID and retire any provisioning
 * profile that predates it.
 *
 * WHY
 *
 * app.json declares `associatedDomains: ["applinks:4kub.ru"]`, but the
 * App Store provisioning profile in use was minted 2026-06-04 without that capability, so every
 * iOS build died at code signing:
 *
 *     Provisioning profile "...AppStore 2026-06-04..." doesn't support the
 *     Associated Domains capability
 *
 * EAS will only fix that in an interactive run, and interactive runs need a Developer Portal
 * login that an app-specific password cannot satisfy. Doing it through the App Store Connect API
 * with an Admin key removes the interactivity entirely.
 *
 * Deleting the profile is safe: a provisioning profile is derived state. Apple reissues it from
 * the App ID, the certificate and the device list, and EAS regenerates one automatically when it
 * finds none. The certificate — the part that actually cannot be recovered — is untouched.
 *
 * Credentials come from C:\Users\fedor\.env (APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID,
 * APPLE_ASC_KEY_PATH). Nothing is printed except identifiers.
 *
 * Usage:
 *   node scripts/asc-fix-capabilities.js            report only
 *   node scripts/asc-fix-capabilities.js --apply    make the changes
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BUNDLE_ID = 'com.fedorportnoi.crm';
const CAPABILITY = 'ASSOCIATED_DOMAINS';
const API = 'https://api.appstoreconnect.apple.com/v1';
const APPLY = process.argv.includes('--apply');

function env(key) {
  const txt = fs.readFileSync(path.join(process.env.USERPROFILE || os.homedir(), '.env'), 'utf8');
  const m = txt.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function token() {
  const kid = env('APPLE_ASC_KEY_ID');
  const iss = env('APPLE_ASC_ISSUER_ID');
  const keyPath = env('APPLE_ASC_KEY_PATH');
  if (!kid || !iss || !keyPath) throw new Error('APPLE_ASC_KEY_ID / ISSUER_ID / KEY_PATH missing');
  const key = fs.readFileSync(keyPath, 'utf8');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid, typ: 'JWT' });
  const body = b64({ iss, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  // ES256 requires the raw r||s pair, not the DER wrapper Node emits by default.
  const sig = crypto
    .sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function api(jwt, method, endpoint, body) {
  const res = await fetch(endpoint.startsWith('http') ? endpoint : API + endpoint, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const detail = json?.errors?.map((e) => `${e.title}: ${e.detail}`).join('; ') || text.slice(0, 300);
    throw new Error(`${method} ${endpoint} -> ${res.status} ${detail}`);
  }
  return json;
}

async function main() {
  const jwt = token();

  const bundles = await api(jwt, 'GET', `/bundleIds?filter[identifier]=${BUNDLE_ID}&limit=200`);
  const bundle = bundles.data.find((b) => b.attributes.identifier === BUNDLE_ID);
  if (!bundle) throw new Error(`Bundle id ${BUNDLE_ID} not found on this team`);
  console.log(`bundle: ${bundle.attributes.name} (${bundle.attributes.identifier}) [${bundle.id}]`);

  // No `limit` here: Apple rejects paging parameters on this relationship with a 400.
  const caps = await api(jwt, 'GET', `/bundleIds/${bundle.id}/bundleIdCapabilities`);
  const present = caps.data.map((c) => c.attributes.capabilityType);
  const hasCap = present.includes(CAPABILITY);
  console.log(`capabilities: ${present.join(', ') || '(none)'}`);
  console.log(`${CAPABILITY}: ${hasCap ? 'already enabled' : 'MISSING'}`);

  if (!hasCap) {
    if (!APPLY) {
      console.log(`\nwould enable ${CAPABILITY} (re-run with --apply)`);
    } else {
      await api(jwt, 'POST', '/bundleIdCapabilities', {
        data: {
          type: 'bundleIdCapabilities',
          attributes: { capabilityType: CAPABILITY },
          relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } },
        },
      });
      console.log(`enabled ${CAPABILITY}`);
    }
  }

  // Any profile issued before the capability existed cannot carry the entitlement, so it has to
  // go. Apple marks such profiles INVALID on its own once the App ID changes, but EAS will keep
  // reusing a cached one until it is actually gone.
  const profiles = await api(jwt, 'GET', '/profiles?limit=200&include=bundleId');
  const mine = profiles.data.filter((p) => {
    const rel = p.relationships?.bundleId?.data?.id;
    return rel === bundle.id;
  });
  console.log(`\nprofiles for this bundle: ${mine.length}`);
  for (const p of mine) {
    const a = p.attributes;
    console.log(`  ${a.name} | ${a.profileType} | ${a.profileState} | expires ${a.expirationDate}`);
  }

  const stale = mine.filter((p) => p.attributes.profileType === 'IOS_APP_STORE');
  if (!stale.length) {
    console.log('\nno App Store profile to retire — EAS will mint one on the next build');
    return;
  }
  if (!APPLY) {
    console.log(`\nwould delete ${stale.length} App Store profile(s) so EAS reissues (re-run with --apply)`);
    return;
  }
  for (const p of stale) {
    await api(jwt, 'DELETE', `/profiles/${p.id}`);
    console.log(`deleted profile: ${p.attributes.name}`);
  }
  console.log('\nEAS will generate a fresh profile on the next build, now carrying the capability.');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
