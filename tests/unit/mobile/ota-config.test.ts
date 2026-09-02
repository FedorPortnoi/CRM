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

describe('update overlay', () => {
  const overlay = fs.readFileSync(
    path.join(root, 'src/components/UpdateOverlay.tsx'),
    'utf8',
  );
  const layout = fs.readFileSync(path.join(root, 'src/app/_layout.tsx'), 'utf8');

  it('renders above the animated splash, which covers the cold-start download', () => {
    // The ON_LOAD download runs during native startup, so the whole window this
    // layer exists for is the one the splash is painted over. Mounted before it,
    // it would be invisible exactly when it is needed.
    const restoringBranch = layout.slice(0, layout.indexOf('<StatusBar'));
    expect(restoringBranch.indexOf('<UpdateOverlay />')).toBeGreaterThan(
      restoringBranch.indexOf('<AnimatedSplash'),
    );
  });

  it('can always be escaped, so it can never repeat the looping-splash lockout', () => {
    expect(overlay).toContain('const DISMISS_AFTER_MS');
    expect(overlay).toContain('const GIVE_UP_MS');
    expect(overlay).toContain('setTimeout(() => setDismissed(true), GIVE_UP_MS)');
  });

  it('restarts only a download the user actually watched', () => {
    // A background download finishing mid-edit must not reload the app out from
    // under whatever the user is typing; it applies on the next launch instead.
    expect(overlay).toContain('(isUpdatePending && watched)');
  });

  it('shows a percentage only when the platform actually reports one', () => {
    // Startup downloads emit no progress at all (only FetchUpdateProcedure does),
    // so anything shown as a number there would be invented.
    expect(overlay).toContain("typeof downloadProgress === 'number' && downloadProgress > 0");
  });

  it('stays inert where updates are disabled, such as a dev client', () => {
    expect(overlay).toContain('Updates.isEnabled &&');
  });
});
