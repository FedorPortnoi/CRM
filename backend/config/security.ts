export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

type RequiredSecretOptions = {
  minLength?: number;
};

type CorsOrigin = boolean | string[];
type DeploymentSafeUrlOptions = {
  requiredInProduction?: boolean;
  allowedProtocols?: string[];
};

type ProductionUrlOptions = {
  allowedProtocols: string[];
  requirePassword?: boolean;
};

const weakSecretValues = new Set([
  'secret',
  'jwt_secret',
  'jwtsecret',
  'changeme',
  'change_me',
  'password',
  'test',
  'development',
  'dev',
]);

function readTrimmedEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getRequiredSecret(
  name: string,
  options: RequiredSecretOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const minLength = options.minLength ?? 32;
  const value = readTrimmedEnv(name, env);

  if (!value) {
    throw new ConfigurationError(`${name} is required`);
  }

  if (value.length < minLength) {
    throw new ConfigurationError(`${name} must be at least ${minLength} characters`);
  }

  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (weakSecretValues.has(normalized) || normalized.includes('change_me')) {
    throw new ConfigurationError(`${name} is too weak`);
  }

  return value;
}

export function getJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  return getRequiredSecret('JWT_SECRET', { minLength: 32 }, env);
}

export function getTokenEncryptionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = readTrimmedEnv('TOKEN_ENCRYPTION_KEY', env);

  if (!value) {
    if (env.NODE_ENV === 'production') {
      throw new ConfigurationError('TOKEN_ENCRYPTION_KEY is required in production');
    }

    return getJwtSecret(env);
  }

  const secret = getRequiredSecret('TOKEN_ENCRYPTION_KEY', { minLength: 32 }, env);
  const jwtSecret = readTrimmedEnv('JWT_SECRET', env);
  if (env.NODE_ENV === 'production' && jwtSecret && secret === jwtSecret) {
    throw new ConfigurationError('TOKEN_ENCRYPTION_KEY must be different from JWT_SECRET in production');
  }

  return secret;
}

export function getYandexWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!readTrimmedEnv('YANDEX_WEBHOOK_SECRET', env)) {
    if (env.NODE_ENV === 'production') {
      throw new ConfigurationError('YANDEX_WEBHOOK_SECRET is required in production');
    }

    return undefined;
  }

  return getRequiredSecret('YANDEX_WEBHOOK_SECRET', { minLength: 32 }, env);
}

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getCorsOrigin(env: NodeJS.ProcessEnv = process.env): CorsOrigin {
  const allowlist = [
    ...parseCsvEnv(env.CORS_ORIGINS),
    ...parseCsvEnv(env.CRM_CORS_ORIGINS),
    ...parseCsvEnv(env.ALLOWED_ORIGINS),
  ];

  if (env.NODE_ENV === 'production') {
    if (allowlist.length === 0) {
      throw new ConfigurationError('CORS_ORIGINS or CRM_CORS_ORIGINS must be set in production');
    }

    return Array.from(new Set(allowlist));
  }

  return allowlist.length > 0 ? Array.from(new Set(allowlist)) : true;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function normalizeProtocol(protocol: string): string {
  const lower = protocol.toLowerCase();
  return lower.endsWith(':') ? lower : `${lower}:`;
}

export function getDeploymentSafeUrl(
  name: string,
  options: DeploymentSafeUrlOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = readTrimmedEnv(name, env);

  if (!value) {
    if (env.NODE_ENV === 'production' && options.requiredInProduction) {
      throw new ConfigurationError(`${name} is required in production`);
    }

    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be a valid absolute URL`);
  }

  const allowedProtocols = options.allowedProtocols?.map(normalizeProtocol)
    ?? (env.NODE_ENV === 'production' ? ['https:'] : undefined);

  if (allowedProtocols && !allowedProtocols.includes(parsed.protocol)) {
    throw new ConfigurationError(`${name} must use one of these protocols: ${allowedProtocols.join(', ')}`);
  }

  if (
    env.NODE_ENV === 'production' &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    isPrivateHostname(parsed.hostname)
  ) {
    throw new ConfigurationError(`${name} must not point to a private or local host in production`);
  }

  return parsed.toString();
}

function validateProductionUrl(
  name: string,
  options: ProductionUrlOptions,
  env: NodeJS.ProcessEnv = process.env,
): URL {
  const value = readTrimmedEnv(name, env);
  if (!value) {
    throw new ConfigurationError(`${name} is required in production`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be a valid absolute URL`);
  }

  const allowedProtocols = options.allowedProtocols.map(normalizeProtocol);
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new ConfigurationError(`${name} must use one of these protocols: ${allowedProtocols.join(', ')}`);
  }

  if (isPrivateHostname(parsed.hostname)) {
    throw new ConfigurationError(`${name} must not point to a private or local host in production`);
  }

  if (options.requirePassword) {
    const password = decodeURIComponent(parsed.password);
    if (!password) {
      throw new ConfigurationError(`${name} must include a database password in production`);
    }

    const weakPassword = password.toLowerCase().replace(/[\s-]+/g, '_');
    if (weakSecretValues.has(weakPassword) || weakPassword.includes('change_me')) {
      throw new ConfigurationError(`${name} uses a default or weak database password`);
    }
  }

  return parsed;
}

export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }

  getJwtSecret(env);
  getTokenEncryptionSecret(env);
  getYandexWebhookSecret(env);
  getCorsOrigin(env);
  validateProductionUrl('DATABASE_URL', {
    allowedProtocols: ['postgresql:', 'postgres:'],
    requirePassword: true,
  }, env);

  const yandexClientId = readTrimmedEnv('YANDEX_CLIENT_ID', env);
  const yandexClientSecret = readTrimmedEnv('YANDEX_CLIENT_SECRET', env);
  if (yandexClientId || yandexClientSecret) {
    if (!yandexClientId || !yandexClientSecret) {
      throw new ConfigurationError('YANDEX_CLIENT_ID and YANDEX_CLIENT_SECRET must be set together');
    }

    getDeploymentSafeUrl('YANDEX_REDIRECT_URI', {
      requiredInProduction: true,
      allowedProtocols: ['https:'],
    }, env);
  }

  if (readTrimmedEnv('YANDEX_CALENDAR_SUCCESS_URL', env)) {
    getDeploymentSafeUrl('YANDEX_CALENDAR_SUCCESS_URL', {
      allowedProtocols: ['https:', 'crm:'],
    }, env);
  }

  if (env.SMSRU_SEND_ENABLED === 'true') {
    getRequiredSecret('SMSRU_API_ID', { minLength: 16 }, env);
  }
}
