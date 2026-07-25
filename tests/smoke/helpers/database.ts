const TEST_DATABASE_NAME_PATTERN = /(?:^|[_-])(?:test|smoke)(?:[_-]|$)/i;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

export function assertSafeSmokeDatabaseUrl(databaseUrl: string, variableName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${variableName} must use the postgres or postgresql protocol.`);
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    throw new Error(`${variableName} contains an invalid encoded database name.`);
  }

  if (!databaseName) {
    throw new Error(`${variableName} must name a database.`);
  }

  if (isLoopbackHost(parsed.hostname) || TEST_DATABASE_NAME_PATTERN.test(databaseName)) {
    return;
  }

  throw new Error(
    `Refusing to use ${variableName}: the host is not loopback and the database name is not marked test/smoke.`,
  );
}

export function getSmokeDatabaseUrl(): string {
  const variableName = process.env.SMOKE_DATABASE_URL
    ? 'SMOKE_DATABASE_URL'
    : process.env.TEST_DATABASE_URL
      ? 'TEST_DATABASE_URL'
      : null;

  if (!variableName) {
    throw new Error(
      'Smoke tests require an explicit SMOKE_DATABASE_URL or TEST_DATABASE_URL. Generic DATABASE_URL is intentionally ignored.',
    );
  }

  const databaseUrl = process.env[variableName];
  if (!databaseUrl) {
    throw new Error(`${variableName} is empty.`);
  }

  assertSafeSmokeDatabaseUrl(databaseUrl, variableName);
  return databaseUrl;
}

export function getSmokeDirectUrl(databaseUrl: string): string {
  const variableName = process.env.SMOKE_DIRECT_URL
    ? 'SMOKE_DIRECT_URL'
    : process.env.TEST_DIRECT_URL
      ? 'TEST_DIRECT_URL'
      : null;
  const directUrl = variableName ? process.env[variableName] : databaseUrl;

  if (!directUrl) {
    throw new Error(`${variableName ?? 'DIRECT_URL'} is empty.`);
  }

  assertSafeSmokeDatabaseUrl(directUrl, variableName ?? 'SMOKE_DATABASE_URL');
  return directUrl;
}
