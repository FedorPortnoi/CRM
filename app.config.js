const APP_ENV = process.env.APP_ENV ?? 'development';

/** @param {{ config: import('@expo/config-types').ExpoConfig }} ctx */
module.exports = ({ config }) => {
  const apiUrls = config.extra?.apiUrls ?? {};
  const apiUrl = apiUrls[APP_ENV] ?? apiUrls['development'] ?? '';

  return {
    ...config,
    extra: {
      ...config.extra,
      appEnv: APP_ENV,
      apiUrl,
    },
  };
};
