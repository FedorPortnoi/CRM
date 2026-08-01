/**
 * Expo config plugin for react-native-rustore-push 6.9.1.
 *
 * The SDK package already contributes its Maven repository, messaging service and
 * `params_class` metadata through its own Android library manifest. Duplicating the service
 * here is actively harmful: the old 0.9.x class name is not present in 6.9.1 and makes the
 * merged application manifest point at a class that cannot be loaded.
 *
 * The application owns one native setting the library cannot supply: the RuStore project id.
 * Automatic initialisation reads it from application-level manifest metadata.
 */

const { withAndroidManifest } = require('@expo/config-plugins');

const PROJECT_ID_META = 'ru.rustore.sdk.pushclient.project_id';
const DEFAULT_CHANNEL_META = 'ru.rustore.sdk.pushclient.default_notification_channel_id';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function upsertMetaData(application, name, value) {
  application['meta-data'] = application['meta-data'] || [];
  const existing = application['meta-data'].find((item) => item?.$?.['android:name'] === name);
  if (existing) {
    existing.$['android:value'] = value;
    return;
  }
  application['meta-data'].push({
    $: {
      'android:name': name,
      'android:value': value,
    },
  });
}

module.exports = function withRuStorePush(config, options = {}) {
  const projectId =
    nonEmpty(options.projectId) ||
    nonEmpty(process.env.EXPO_PUBLIC_RUSTORE_PROJECT_ID) ||
    nonEmpty(config.extra?.rustoreProjectId);

  if (!projectId) {
    // The same app config is evaluated for iOS, web, Google Play and local Expo development.
    // Those builds must keep their existing Expo/APNs transport and do not need a RuStore id.
    // The dedicated `rustore` EAS profile sets RUSTORE_PUSH_REQUIRED so that its Android release
    // still fails closed instead of producing an APK whose native module can never initialize.
    if (String(process.env.RUSTORE_PUSH_REQUIRED).toLowerCase() === 'true') {
      throw new Error(
        'withRuStorePush: set EXPO_PUBLIC_RUSTORE_PROJECT_ID for the required RuStore build.',
      );
    }
    return config;
  }

  const channelId = nonEmpty(options.defaultChannelId) || 'default';
  const next = withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) throw new Error('withRuStorePush: AndroidManifest has no <application>.');

    upsertMetaData(application, PROJECT_ID_META, projectId);
    upsertMetaData(application, DEFAULT_CHANNEL_META, channelId);
    return cfg;
  });

  next.extra = { ...(next.extra || {}), rustoreProjectId: projectId };
  return next;
};
