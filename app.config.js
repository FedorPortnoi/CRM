const APP_ENV = process.env.APP_ENV ?? 'development';
const DEPLOYMENT_ENVS = new Set(['staging', 'production']);
const RAILWAY_PLACEHOLDER_DOMAIN = ['railway', 'app'].join('.');
const PLACEHOLDER_HOSTS = new Set([
  `api.${RAILWAY_PLACEHOLDER_DOMAIN}`,
  `staging.${RAILWAY_PLACEHOLDER_DOMAIN}`,
]);

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function deploymentApiUrlError(apiUrl) {
  if (!apiUrl) return 'EXPO_PUBLIC_API_URL is not set';

  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return 'EXPO_PUBLIC_API_URL is not a valid URL';
  }

  const lowerUrl = apiUrl.toLowerCase();
  if (parsed.protocol !== 'https:') return 'EXPO_PUBLIC_API_URL must use HTTPS';
  if (!parsed.pathname.replace(/\/+$/, '').endsWith('/api/v1')) {
    return 'EXPO_PUBLIC_API_URL must end with /api/v1';
  }
  if (
    PLACEHOLDER_HOSTS.has(parsed.hostname.toLowerCase()) ||
    lowerUrl.includes('placeholder') ||
    lowerUrl.includes('example.com') ||
    isPrivateHostname(parsed.hostname)
  ) {
    return 'EXPO_PUBLIC_API_URL must be a real deployed API URL';
  }

  return null;
}

/** @param {{ config: import('@expo/config-types').ExpoConfig }} ctx */
module.exports = ({ config }) => {
  const apiUrls = config.extra?.apiUrls ?? {};
  const envApiUrl = stringValue(process.env.EXPO_PUBLIC_API_URL);
  const fallbackApiUrl = stringValue(apiUrls[APP_ENV] ?? apiUrls['development']);
  const apiUrl = envApiUrl || (DEPLOYMENT_ENVS.has(APP_ENV) ? '' : fallbackApiUrl);

  if (DEPLOYMENT_ENVS.has(APP_ENV) && process.env.EXPO_SKIP_API_URL_CHECK !== 'true') {
    const error = deploymentApiUrlError(apiUrl);
    if (error) {
      throw new Error(`APP_ENV=${APP_ENV} requires a production-safe EXPO_PUBLIC_API_URL: ${error}.`);
    }
  }

  return {
    ...config,
    android: {
      ...config.android,
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON || config.android?.googleServicesFile || './google-services.json',
    },
    extra: {
      ...config.extra,
      appEnv: APP_ENV,
      apiUrl,
    },
  };
};
