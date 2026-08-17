#!/usr/bin/env node
'use strict';
/**
 * Drive an App Store release to completion through the App Store Connect API.
 *
 * WHY THIS EXISTS
 *
 * `eas submit` uploads a binary to App Store Connect and stops there. It does not create the
 * App Store version, attach the build to it, choose a release strategy, or submit for review —
 * those are separate API calls, and without them the build simply sits in TestFlight while
 * everyone assumes it is "submitted".
 *
 * This closes that gap, including the part that is easy to forget: releaseType AFTER_APPROVAL,
 * which is what "release automatically once Apple approves" actually means. The default is
 * MANUAL, where an approved build waits indefinitely for someone to press a button.
 *
 * Credentials come from C:\Users\fedor\.env (APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID,
 * APPLE_ASC_KEY_PATH). The key must have Admin or App Manager rights.
 *
 * Usage:
 *   node scripts/asc-release.js                    report build + version state
 *   node scripts/asc-release.js --submit           create/attach/submit 1.1.6 for review
 *   node scripts/asc-release.js --submit --manual  same, but release manually after approval
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP_ID = '6776447873';           // 4КУБ — verified against /v1/apps
const API = 'https://api.appstoreconnect.apple.com/v1';
const VERSION = require('../app.json').expo.version;
const SUBMIT = process.argv.includes('--submit');
const RELEASE_TYPE = process.argv.includes('--manual') ? 'MANUAL' : 'AFTER_APPROVAL';

const WHATS_NEW_RU = [
  'Двухфакторная аутентификация (2FA): включите в Настройках → Безопасность —',
  'дополнительный код из приложения-аутентификатора при входе, плюс 10',
  'резервных кодов на случай потери телефона. Отключена по умолчанию —',
  'решаете сами, включать или нет.',
  '',
  'Мелкие исправления стабильности.',
].join('\n');

const WHATS_NEW_EN = [
  'Two-factor authentication (2FA): turn it on in Settings -> Security for an',
  'extra code from an authenticator app at login, plus 10 backup codes in case',
  'you lose your phone. Off by default -- opt in whenever you want it.',
  '',
  'Minor stability fixes.',
].join('\n');

function envValue(key) {
  const txt = fs.readFileSync(path.join(process.env.USERPROFILE || os.homedir(), '.env'), 'utf8');
  const m = txt.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function token() {
  const kid = envValue('APPLE_ASC_KEY_ID');
  const iss = envValue('APPLE_ASC_ISSUER_ID');
  const key = fs.readFileSync(envValue('APPLE_ASC_KEY_PATH'), 'utf8');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid, typ: 'JWT' });
  const body = b64({ iss, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  // ES256 wants the raw r||s pair; Node emits DER unless told otherwise.
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
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const detail = json?.errors?.map((e) => `${e.title}: ${e.detail}`).join('; ') || text.slice(0, 400);
    throw new Error(`${method} ${endpoint} -> ${res.status} ${detail}`);
  }
  return json;
}

(async () => {
  const jwt = token();

  const builds = await api(jwt, 'GET', `/builds?filter[app]=${APP_ID}&limit=10&sort=-uploadedDate`);
  console.log('recent builds:');
  for (const b of builds.data) {
    const a = b.attributes;
    console.log(`  v${a.version} | ${a.processingState} | expires ${a.expired} | uploaded ${a.uploadedDate}`);
  }

  const versions = await api(jwt, 'GET', `/apps/${APP_ID}/appStoreVersions?limit=10`);
  console.log('\napp store versions:');
  for (const v of versions.data) {
    console.log(`  ${v.attributes.versionString} | ${v.attributes.appStoreState} | release=${v.attributes.releaseType}`);
  }

  if (!SUBMIT) {
    console.log(`\nRe-run with --submit to submit ${VERSION} for review (release: ${RELEASE_TYPE}).`);
    return;
  }

  // The uploaded binary must finish processing before it can be attached; attaching a
  // PROCESSING build fails, and the failure reads like a permissions problem rather than a
  // timing one.
  const target = builds.data.find(
    (b) => b.attributes.version === String(require('../app.json').expo.ios.buildNumber)
      || b.attributes.processingState === 'VALID',
  );
  if (!target) throw new Error('no VALID build available yet — wait for App Store Connect processing');
  if (target.attributes.processingState !== 'VALID') {
    throw new Error(`build is ${target.attributes.processingState}, not VALID — wait and retry`);
  }
  console.log(`\nusing build ${target.attributes.version} (${target.id})`);

  let version = versions.data.find((v) => v.attributes.versionString === VERSION);
  if (!version) {
    const created = await api(jwt, 'POST', '/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: VERSION, releaseType: RELEASE_TYPE },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      },
    });
    version = created.data;
    console.log(`created version ${VERSION} (releaseType ${RELEASE_TYPE})`);
  } else {
    await api(jwt, 'PATCH', `/appStoreVersions/${version.id}`, {
      data: { type: 'appStoreVersions', id: version.id, attributes: { releaseType: RELEASE_TYPE } },
    });
    console.log(`reusing version ${VERSION} (releaseType set to ${RELEASE_TYPE})`);
  }

  await api(jwt, 'PATCH', `/appStoreVersions/${version.id}/relationships/build`, {
    data: { type: 'builds', id: target.id },
  });
  console.log('build attached to version');

  // Release notes. Apple rejects a submission whose localization has no whatsNew on an update,
  // and the rejection arrives hours later as a metadata issue rather than immediately.
  const locs = await api(jwt, 'GET', `/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  for (const loc of locs.data) {
    if (loc.attributes.whatsNew && loc.attributes.whatsNew.trim()) continue;
    const ru = loc.attributes.locale.startsWith('ru');
    await api(jwt, 'PATCH', `/appStoreVersionLocalizations/${loc.id}`, {
      data: {
        type: 'appStoreVersionLocalizations',
        id: loc.id,
        attributes: { whatsNew: ru ? WHATS_NEW_RU : WHATS_NEW_EN },
      },
    });
    console.log(`set release notes for ${loc.attributes.locale}`);
  }

  // appStoreVersionSubmissions is DELETE-only now; Apple moved creation to reviewSubmissions,
  // which models a submission as a container of items so several resources can go to review
  // together. Three calls: open the submission, add the version, then mark it submitted.
  const existing = await api(
    jwt, 'GET',
    `/apps/${APP_ID}/reviewSubmissions?filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW`,
  );
  let review = existing.data[0];
  if (review) {
    console.log(`reusing open review submission ${review.id} (${review.attributes.state})`);
  } else {
    const created = await api(jwt, 'POST', '/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      },
    });
    review = created.data;
    console.log(`opened review submission ${review.id}`);
  }

  const items = await api(jwt, 'GET', `/reviewSubmissions/${review.id}/items`);
  const alreadyIn = items.data.some(
    (it) => it.relationships?.appStoreVersion?.data?.id === version.id,
  );
  if (!alreadyIn) {
    await api(jwt, 'POST', '/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: review.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
        },
      },
    });
    console.log(`added version ${VERSION} to the submission`);
  }

  await api(jwt, 'PATCH', `/reviewSubmissions/${review.id}`, {
    data: { type: 'reviewSubmissions', id: review.id, attributes: { submitted: true } },
  });
  console.log(`submitted for review: ${review.id}`);
  console.log(`\n${VERSION} is with Apple. On approval it releases ${RELEASE_TYPE === 'AFTER_APPROVAL' ? 'automatically' : 'only when you press the button'}.`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
