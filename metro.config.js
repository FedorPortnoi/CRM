const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Enable package exports so Metro resolves the correct CJS/ESM entry points.
// Without this, packages like @supabase/supabase-js use their ESM build which
// contains import.meta — invalid in a non-module Metro web bundle.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
