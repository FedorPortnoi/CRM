import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceOf(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('animated splash native handoff', () => {
  it('ships the native splash module as a direct dependency', () => {
    const pkg = JSON.parse(sourceOf('package.json')) as {
      dependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.['expo-splash-screen']).toBe('~31.0.13');
  });

  it('holds the native screen until video or the dark fallback has painted', () => {
    const source = sourceOf('src/components/AnimatedSplash.tsx');
    const firstFrameStart = source.indexOf('onFirstFrameRender');
    const firstFrame = source.slice(firstFrameStart, source.indexOf('/>', firstFrameStart));

    expect(source).toContain('SplashScreen.preventAutoHideAsync()');
    expect(firstFrame).toContain('hideNativeSplashOnce()');
    expect(source).toContain('fallbackLaidOut && (reduceMotion === true || videoFailed)');
  });

  it('keeps the overlay up while the index route is still deciding where to go', () => {
    expect(sourceOf('src/app/_layout.tsx')).toContain("ready={pathname !== '/'}");
  });
});
