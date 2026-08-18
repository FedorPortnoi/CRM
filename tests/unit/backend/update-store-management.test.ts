import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The release utility is CommonJS so operators can run it with plain Node.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const manager = require('../../../scripts/manage-updates.js') as {
  inspectStore: (store: string) => Array<Record<string, string | null>>;
  main: (args: string[]) => void;
  parseArgs: (args: string[]) => Record<string, unknown>;
};

const RUNTIME = '1.1.8-native2';
const CHANNEL = 'production';
const UPDATE_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-08-18T12:00:00.000Z';

let storeDir: string;
let channelDir: string;

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-manage-updates-'));
  channelDir = path.join(storeDir, RUNTIME, CHANNEL);
  const updateDir = path.join(channelDir, UPDATE_ID);
  fs.mkdirSync(updateDir, { recursive: true });
  fs.writeFileSync(
    path.join(updateDir, 'update.json'),
    JSON.stringify({
      id: UPDATE_ID,
      createdAt: CREATED_AT,
      runtimeVersion: RUNTIME,
      channel: CHANNEL,
      platforms: {
        ios: { launchAsset: { path: 'ios.js' }, assets: [] },
        android: { launchAsset: { path: 'android.js' }, assets: [] },
      },
      extra: { commit: 'abc123' },
    }),
    'utf8',
  );
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe('self-hosted update store management', () => {
  it('reports the explicit native compatibility runtime per platform', () => {
    const rows = manager.inspectStore(storeDir);

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runtime: RUNTIME, channel: CHANNEL, platform: 'ios' }),
        expect.objectContaining({ runtime: RUNTIME, channel: CHANNEL, platform: 'android' }),
      ]),
    );
  });

  it('creates and clears a platform-specific rollback marker', () => {
    manager.main([
      'rollback',
      '--runtime',
      RUNTIME,
      '--channel',
      CHANNEL,
      '--platform',
      'ios',
      '--store',
      storeDir,
    ]);

    const iosMarker = path.join(channelDir, 'rollback.ios.json');
    expect(fs.existsSync(iosMarker)).toBe(true);
    expect(fs.existsSync(path.join(channelDir, 'rollback.android.json'))).toBe(false);
    expect(Date.parse(JSON.parse(fs.readFileSync(iosMarker, 'utf8')).commitTime)).toBeGreaterThan(
      Date.parse(CREATED_AT),
    );

    manager.main([
      'resume',
      '--runtime',
      RUNTIME,
      '--channel',
      CHANNEL,
      '--platform',
      'ios',
      '--store',
      storeDir,
    ]);
    expect(fs.existsSync(iosMarker)).toBe(false);
  });

  it('does not mutate the store during a dry run', () => {
    manager.main([
      'rollback',
      '--runtime',
      RUNTIME,
      '--channel',
      CHANNEL,
      '--platform',
      'all',
      '--store',
      storeDir,
      '--dry-run',
    ]);

    expect(fs.existsSync(path.join(channelDir, 'rollback.ios.json'))).toBe(false);
    expect(fs.existsSync(path.join(channelDir, 'rollback.android.json'))).toBe(false);
  });

  it('rejects unsafe runtime and channel paths', () => {
    expect(() => manager.parseArgs(['status', '--runtime', '..'])).toThrow('invalid --runtime');
    expect(() => manager.parseArgs(['status', '--channel', '../production'])).toThrow(
      'invalid --channel',
    );
  });
});
