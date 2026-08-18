import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type GradleProperty =
  | { type: 'property'; key: string; value: string }
  | { type: 'comment'; value: string };

const plugin = require('../../../plugins/withRuStoreInstallReferrer') as {
  addRuStoreMavenRepository(properties: GradleProperty[]): GradleProperty[];
  EXTRA_MAVEN_REPOS_KEY: string;
  RUSTORE_MAVEN_REPOSITORY: string;
};

describe('RuStore Install Referrer native build contract', () => {
  it('adds the official repository through Expo root-project autolinking', () => {
    const properties: GradleProperty[] = [];

    plugin.addRuStoreMavenRepository(properties);

    const property = properties.find(
      (item): item is Extract<GradleProperty, { type: 'property' }> =>
        item.type === 'property' && item.key === plugin.EXTRA_MAVEN_REPOS_KEY,
    );
    expect(property).toBeDefined();
    expect(JSON.parse(property!.value)).toEqual([{ url: plugin.RUSTORE_MAVEN_REPOSITORY }]);
  });

  it('preserves existing repositories and is idempotent', () => {
    const properties: GradleProperty[] = [
      {
        type: 'property',
        key: plugin.EXTRA_MAVEN_REPOS_KEY,
        value: JSON.stringify([{ url: 'https://packages.example.test/maven' }]),
      },
    ];

    plugin.addRuStoreMavenRepository(properties);
    plugin.addRuStoreMavenRepository(properties);

    const value = (properties[0] as Extract<GradleProperty, { type: 'property' }>).value;
    expect(JSON.parse(value)).toEqual([
      { url: 'https://packages.example.test/maven' },
      { url: plugin.RUSTORE_MAVEN_REPOSITORY },
    ]);
  });

  it('is wired into app config alongside the pinned native dependency', () => {
    const appConfig = JSON.parse(readFileSync(resolve('app.json'), 'utf8')) as {
      expo: { plugins: unknown[] };
    };
    const moduleGradle = readFileSync(
      resolve('modules/rustore-install-referrer/android/build.gradle'),
      'utf8',
    );

    expect(appConfig.expo.plugins).toContain('./plugins/withRuStoreInstallReferrer');
    expect(moduleGradle).toContain("implementation 'ru.rustore.sdk:installreferrer:10.6.1'");
  });
});
