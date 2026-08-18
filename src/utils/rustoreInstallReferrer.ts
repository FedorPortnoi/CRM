import { requireOptionalNativeModule } from 'expo-modules-core';

type RuStoreInstallReferrerNativeModule = {
  getInstallReferrer(): Promise<string | null>;
};

const nativeModule =
  requireOptionalNativeModule<RuStoreInstallReferrerNativeModule>('RuStoreInstallReferrer');

/**
 * Return the install handoff supplied by RuStore, or null on platforms/builds
 * where the Android native module is unavailable.
 */
export async function getInstallReferrer(): Promise<string | null> {
  if (nativeModule === null) return null;

  const value = await nativeModule.getInstallReferrer();
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
