import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

export const DEFAULT_API_URL = 'http://127.0.0.1:3000/api/v1';

type ApiUrlMap = Record<string, unknown>;

export type ResolveApiUrlOptions = {
  expoApiUrl?: unknown;
  expoApiUrls?: unknown;
  appEnv?: unknown;
  nodeEnv?: unknown;
  envApiUrl?: unknown;
  defaultApiUrl?: string;
};

function normalizeApiUrl(url: string): string | null {
  const normalized = url.trim().replace(/\/+$/, '');

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isProductionEnv(appEnv: unknown, nodeEnv: unknown): boolean {
  return nonEmptyString(appEnv) === 'production' || nonEmptyString(nodeEnv) === 'production';
}

function apiUrlFromMap(
  apiUrls: unknown,
  appEnv: unknown,
  allowDevelopmentFallback: boolean,
): string | null {
  if (!apiUrls || typeof apiUrls !== 'object') {
    return null;
  }

  const urls = apiUrls as ApiUrlMap;
  const env = nonEmptyString(appEnv);
  const envUrl = env ? usableApiUrl(urls[env]) : null;

  if (envUrl !== null) {
    return envUrl;
  }

  return allowDevelopmentFallback ? usableApiUrl(urls.development) : null;
}

function usableApiUrl(value: unknown): string | null {
  const url = nonEmptyString(value);
  return url ? normalizeApiUrl(url) : null;
}

function isUnsafeProductionApiUrl(url: string): boolean {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost') ||
    hostname === 'api.railway.app' ||
    url.toLowerCase().includes('placeholder')
  );
}

export function resolveApiUrl(options: ResolveApiUrlOptions = {}): string {
  const isProduction = isProductionEnv(options.appEnv, options.nodeEnv);
  const resolved =
    usableApiUrl(options.envApiUrl) ??
    usableApiUrl(options.expoApiUrl) ??
    apiUrlFromMap(options.expoApiUrls, options.appEnv, !isProduction) ??
    (isProduction ? null : usableApiUrl(options.defaultApiUrl)) ??
    (isProduction ? null : DEFAULT_API_URL);

  if (!resolved) {
    throw new Error(
      'Production API URL is not configured. Set EXPO_PUBLIC_API_URL or extra.apiUrl to a deployed API URL.',
    );
  }

  if (isProduction && isUnsafeProductionApiUrl(resolved)) {
    throw new Error(
      'Production API URL must point to a deployed API, not localhost or a placeholder URL.',
    );
  }

  return resolved;
}

const extra = Constants.expoConfig?.extra ?? {};

const API_URL: string = resolveApiUrl({
  expoApiUrl: extra.apiUrl,
  expoApiUrls: extra.apiUrls,
  appEnv: extra.appEnv,
  nodeEnv: process.env.NODE_ENV,
  envApiUrl: process.env.EXPO_PUBLIC_API_URL,
});

export { API_URL };

export async function authHeaders(): Promise<{ 'Content-Type': string; Authorization: string }> {
  const token = await SecureStore.getItemAsync('crm_auth_token');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` };
}
