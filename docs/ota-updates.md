# Frontend OTA and backend release guide

The App Store and RuStore binaries include `expo-updates`, so compatible
JavaScript and bundled assets can be changed without another store upload. The
backend is deployed independently at `https://4kub.ru/api/v1`.

## Compatibility boundary

The replacement iOS and Android binaries use the explicit runtime
`1.1.8-native2`. This is intentionally different from the old 1.1.8 binaries,
which use runtime `1.1.8` but do not contain the new splash/referrer native
modules. Never publish a new bundle to runtime `1.1.8` expecting it to reach the
replacement builds.

An OTA update is appropriate for:

- TypeScript/JavaScript behavior, screens, navigation, styles, and copy;
- translations and API-client logic;
- images, fonts, audio, and video bundled by Metro;
- fixes that use only native modules already present in the target binary.

A new store binary and a new explicit runtime are required for:

- adding, removing, or upgrading a dependency that contains native code;
- changing Expo SDK, React Native, config plugins, or `modules/`;
- native iOS/Android code, entitlements, permissions, intent filters, or
  associated domains;
- native splash/icon configuration or any other build-time app configuration.

When uncertain, treat the change as native. A runtime string is a compatibility
promise, not merely a release label.

## Channels baked into builds

Each release profile has the same channel declared twice on purpose:

- `eas.json` `channel` lets EAS Build inject it;
- `EXPO_UPDATES_CHANNEL` lets `app.config.js` embed the same
  `expo-channel-name` request header for local/prebuilt release builds.

`scripts/publish-update.js` rejects profiles where those values disagree.

| Binary | Build profile | OTA channel | Platform |
|---|---|---|---|
| App Store | `production` | `production` | iOS |
| Google Play, if used | `production` | `production` | Android |
| RuStore | `rustore` | `rustore` | Android |
| AppGallery | `huawei` | `huawei` | Android |

## Publish a frontend update

1. Confirm the change is OTA-compatible using the boundary above.
2. Commit it. The publisher refuses a dirty tree so every shipped bundle maps
   to a reproducible Git commit.
3. Run the normal typecheck/tests and inspect the update store:

   ```text
   npm run typecheck
   npm test -- --run
   npm run updates:status
   ```

4. Dry-run the exact target. The first publish for `1.1.8-native2` needs
   `--new-runtime`; later publishes omit it.

   ```text
   npm run updates:publish -- --channel production --platform ios --new-runtime --dry-run
   npm run updates:publish -- --channel rustore --profile rustore --platform android --new-runtime --dry-run
   ```

5. Publish each store channel separately:

   ```text
   npm run updates:publish -- --channel production --platform ios --new-runtime
   npm run updates:publish -- --channel rustore --profile rustore --platform android --new-runtime
   ```

   After the first successful publish for the tuple, remove `--new-runtime`.
   Devices on another runtime, channel, or platform cannot receive it.

The manifest and rollback directives are signed with the private key outside
Git. The matching public certificate is embedded in every binary. Never rotate
that pair without a planned native transition: existing binaries trust only the
certificate they shipped with.

## Roll back a bad frontend update

Rollbacks are platform-specific so an iOS incident does not disable a healthy
Android update on the same runtime:

```text
npm run updates:rollback -- --runtime 1.1.8-native2 --channel production --platform ios --dry-run
npm run updates:rollback -- --runtime 1.1.8-native2 --channel production --platform ios
```

The server then directs that target back to the bundle embedded in its binary.
Commit and publish the corrected update while the marker remains active. After
validation, remove the marker so the fixed update becomes visible:

```text
npm run updates:resume -- --runtime 1.1.8-native2 --channel production --platform ios --dry-run
npm run updates:resume -- --runtime 1.1.8-native2 --channel production --platform ios
```

Use `npm run updates:status` after every publish, rollback, or resume.

## Backend changes without a mobile upload

Backend code can be rebuilt and restarted independently; the app uses the
stable 4kub.ru API hostname rather than a build-specific server address. Store
binaries still exist in the wild and an OTA can roll back to its embedded
bundle, so API and database changes must remain backward-compatible.

For a breaking contract, use an expand/migrate/contract sequence:

1. deploy additive backend fields/routes and a backward-compatible migration;
2. publish the compatible mobile change by OTA;
3. wait until old embedded/store clients no longer need the old contract;
4. only then remove the old field/route and contract the database.

Backend-only behavior, validation, email, integrations, and server-rendered
invite-page changes need no mobile build or OTA as long as their API contract
remains compatible.

## Startup behavior

Updates are checked on app load. `fallbackToCacheTimeout` gives the native
loader a bounded opportunity to apply a new bundle immediately; if the network
is unavailable, the embedded or last successful bundle remains the recovery
path. Expo's anti-bricking measures and the embedded update stay enabled.

References: [Expo runtime compatibility](https://docs.expo.dev/eas-update/runtime-versions/),
[channel configuration](https://docs.expo.dev/eas-update/getting-started/), and
[rollback behavior](https://docs.expo.dev/eas-update/rollbacks/).
