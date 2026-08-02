#!/usr/bin/env node
'use strict';
/**
 * Interactive iOS build with Apple credentials loaded from the master .env.
 *
 * WHY THIS EXISTS
 *
 * `eas build --non-interactive` will USE stored credentials but refuses to CHANGE them.
 * When app.json declares a capability the provisioning profile predates — as happened with
 * `associatedDomains` (applinks:4kub.ru) against a profile minted 2026-06-04 — the build
 * reaches code signing and dies with:
 *
 *     Provisioning profile "...AppStore 2026-06-04..." doesn't support the
 *     Associated Domains capability
 *
 * Fixing that means enabling the capability on the App ID and reissuing the profile, which
 * only Apple can do and which EAS will only attempt in an interactive run.
 *
 * Passing the password on the command line would put it in shell history and in the process
 * list, so this reads it from C:\Users\fedor\.env instead and hands it to the child process
 * through the environment. Nothing secret is printed.
 *
 * USAGE
 *   node scripts/eas-ios-build.js            build (interactive where it must be)
 *   node scripts/eas-ios-build.js --submit   build, then submit to App Store Connect
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MASTER_ENV = path.join(process.env.USERPROFILE || require('os').homedir(), '.env');

function readEnvValue(text, key) {
  const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function main() {
  if (!fs.existsSync(MASTER_ENV)) {
    console.error(`Missing ${MASTER_ENV} — Apple credentials live there.`);
    process.exit(1);
  }
  const txt = fs.readFileSync(MASTER_ENV, 'utf8');

  const appleId = readEnvValue(txt, 'APPLE_ID');
  const appPassword = readEnvValue(txt, 'APPLE_APP_SPECIFIC_PASSWORD');
  const teamId = readEnvValue(txt, 'APPLE_TEAM_ID');
  const ascKeyId = readEnvValue(txt, 'APPLE_ASC_KEY_ID');
  const ascIssuerId = readEnvValue(txt, 'APPLE_ASC_ISSUER_ID');
  const ascKeyPath = readEnvValue(txt, 'APPLE_ASC_KEY_PATH');

  const missing = [];
  if (!appleId) missing.push('APPLE_ID');
  if (!appPassword) missing.push('APPLE_APP_SPECIFIC_PASSWORD');
  if (missing.length) {
    console.error(`Missing in ${MASTER_ENV}: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Report presence, never values.
  console.log('Apple credentials loaded from master .env:');
  console.log(`  APPLE_ID                      ${appleId}`);
  console.log("  (app-specific password intentionally NOT used - see comment below)");
  console.log(`  APPLE_TEAM_ID                 ${teamId || '(unset)'}`);
  console.log(`  ASC key                       ${ascKeyId || '(unset)'}`);
  console.log('');
  console.log('If EAS asks to enable a capability or reissue the provisioning profile, answer YES —');
  console.log('that is the whole point of running this interactively.');
  console.log('');

  // EXPO_APPLE_APP_SPECIFIC_PASSWORD is deliberately NOT set here.
  //
  // App-specific passwords authenticate uploads and notarization. They do NOT authenticate the
  // Developer Portal, which is what creating a provisioning profile requires. Supplying one made
  // eas-cli retry a doomed login three times and then hang, rather than prompting for the real
  // credentials. Leaving it unset lets it ask for the account password and 2FA code, which is the
  // only thing Apple accepts for this operation.
  const env = {
    ...process.env,
    EXPO_APPLE_ID: appleId,
    ...(teamId ? { EXPO_APPLE_TEAM_ID: teamId } : {}),
    EXPO_APPLE_TEAM_TYPE: 'INDIVIDUAL',
    ...(ascKeyId ? { EXPO_ASC_KEY_ID: ascKeyId } : {}),
    ...(ascIssuerId ? { EXPO_ASC_ISSUER_ID: ascIssuerId } : {}),
    ...(ascKeyPath && fs.existsSync(ascKeyPath) ? { EXPO_ASC_API_KEY_PATH: ascKeyPath } : {}),
  };

  const args = ['eas-cli', 'build', '--platform', 'ios', '--profile', 'production'];
  if (process.argv.includes('--submit')) args.push('--auto-submit');

  const child = spawn('npx', args, {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: path.join(__dirname, '..'),
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

main();
