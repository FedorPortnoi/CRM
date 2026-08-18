import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
const eas = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8'));

type ResolvedExpoConfig = {
  runtimeVersion?: unknown;
  updates: {
    url?: unknown;
    requestHeaders: Record<string, string>;
  };
};

function resolvedConfig(env: Record<string, string>): ResolvedExpoConfig {
  const script = [
    "const base = require('./app.json').expo;",
    "const config = require('./app.config.js')({ config: base });",
    'process.stdout.write(JSON.stringify(config));',
  ].join('');
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }),
  ) as ResolvedExpoConfig;
}

describe('OTA build configuration', () => {
  it('isolates replacement binaries from old 1.1.8 native code', () => {
    // Build 40 and Android code 14 already use runtime 1.1.8. The replacement
    // binaries add native modules, so sharing that runtime would let a new JS
    // update crash those older installs.
    expect(appJson.expo.runtimeVersion).toBe('1.1.8-native2');
  });

  it.each(['preview', 'production', 'rustore', 'rustore-nopush', 'huawei'])(
    'embeds the %s profile channel in native update request headers',
    (profileName) => {
      const profile = eas.build[profileName];
      expect(profile.env.EXPO_UPDATES_CHANNEL).toBe(profile.channel);

      const config = resolvedConfig({
        ...profile.env,
        // Preview normally receives this from the EAS environment rather than
        // from eas.json; use the production-safe shape for deterministic tests.
        EXPO_PUBLIC_API_URL: profile.env.EXPO_PUBLIC_API_URL ?? 'https://staging.4kub.ru/api/v1',
      });
      expect(config.runtimeVersion).toBe('1.1.8-native2');
      expect(config.updates.requestHeaders['expo-channel-name']).toBe(profile.channel);
      expect(config.updates.url).toBe('https://4kub.ru/api/v1/updates/manifest');
    },
  );

  it('keeps the embedded rollback path enabled and code signing configured', () => {
    expect(appJson.expo.updates.useEmbeddedUpdate).not.toBe(false);
    expect(appJson.expo.updates.codeSigningCertificate).toBe(
      './certs/updates/certificate.pem',
    );
    expect(appJson.expo.updates.codeSigningMetadata).toEqual({
      keyid: 'main',
      alg: 'rsa-v1_5-sha256',
    });
  });
});
