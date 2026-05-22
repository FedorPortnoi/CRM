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
