/**
 * Make RuStore's Install Referrer artifact resolvable in generated Android builds.
 *
 * A repository declared inside the local library project is too late for builds
 * whose dependency resolution is governed by the generated root project. Expo
 * Autolinking consumes `android.extraMavenRepos` from gradle.properties and adds
 * every entry to rootProject.allprojects before dependencies are resolved.
 */

const { withGradleProperties } = require('@expo/config-plugins');

const EXTRA_MAVEN_REPOS_KEY = 'android.extraMavenRepos';
const RUSTORE_MAVEN_REPOSITORY =
  'https://artifactory-external.vkpartner.ru/artifactory/maven';

function addRuStoreMavenRepository(properties) {
  const existing = properties.find(
    (item) => item?.type === 'property' && item.key === EXTRA_MAVEN_REPOS_KEY,
  );

  let repositories = [];
  if (existing) {
    try {
      repositories = JSON.parse(existing.value);
    } catch {
      throw new Error(
        `withRuStoreInstallReferrer: ${EXTRA_MAVEN_REPOS_KEY} must be a JSON array.`,
      );
    }
    if (!Array.isArray(repositories)) {
      throw new Error(
        `withRuStoreInstallReferrer: ${EXTRA_MAVEN_REPOS_KEY} must be a JSON array.`,
      );
    }
  }

  if (!repositories.some((repository) => repository?.url === RUSTORE_MAVEN_REPOSITORY)) {
    repositories.push({ url: RUSTORE_MAVEN_REPOSITORY });
  }

  const value = JSON.stringify(repositories);
  if (existing) {
    existing.value = value;
  } else {
    properties.push({ type: 'property', key: EXTRA_MAVEN_REPOS_KEY, value });
  }
  return properties;
}

function withRuStoreInstallReferrer(config) {
  return withGradleProperties(config, (nextConfig) => {
    nextConfig.modResults = addRuStoreMavenRepository(nextConfig.modResults);
    return nextConfig;
  });
}

module.exports = withRuStoreInstallReferrer;
module.exports.addRuStoreMavenRepository = addRuStoreMavenRepository;
module.exports.EXTRA_MAVEN_REPOS_KEY = EXTRA_MAVEN_REPOS_KEY;
module.exports.RUSTORE_MAVEN_REPOSITORY = RUSTORE_MAVEN_REPOSITORY;
