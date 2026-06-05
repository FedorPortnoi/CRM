const { withStringsXml } = require('@expo/config-plugins');

module.exports = function withAndroidDisplayName(config, displayName) {
  return withStringsXml(config, (config) => {
    const strings = config.modResults.resources.string ?? [];
    const existing = strings.find((s) => s.$.name === 'app_name');
    if (existing) {
      existing._ = displayName;
    } else {
      strings.push({ $: { name: 'app_name' }, _: displayName });
    }
    config.modResults.resources.string = strings;
    return config;
  });
};
