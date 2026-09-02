import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Updates from 'expo-updates';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, radius, spacing, type } from '../theme';

/**
 * The screen that says "the app is updating", instead of the app silently
 * looking unchanged.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * app.json sets `checkAutomatically: ON_LOAD` with `fallbackToCacheTimeout:
 * 15000`, and the JS bundle is ~12 MB. On a phone connection that download does
 * not finish inside 15 s, so the launch that triggers it runs the OLD bundle and
 * the new one only takes effect on the NEXT cold start. From the outside that is
 * indistinguishable from a deploy that never happened — which is exactly the
 * report this component answers ("I opened the app and the new field isn't
 * there"). Nothing was broken; nothing said anything.
 *
 * ─── WHY THERE IS NO PERCENTAGE ON A STARTUP DOWNLOAD ───────────────────────
 *
 * expo-updates emits `downloadProgress` from ONE place: FetchUpdateProcedure,
 * i.e. a download that JS asked for with fetchUpdateAsync(). Checked in the
 * installed copy of the library, both platforms —
 *   node_modules/expo-updates/ios/EXUpdates/Procedures/FetchUpdateProcedure.swift:58
 *   node_modules/expo-updates/android/.../procedures/FetchUpdateProcedure.kt:62
 * StartupProcedure, which is what ON_LOAD runs, emits `.download` and
 * `.downloadComplete` and no progress at all. So a launch-time download can be
 * reported as happening, honestly, but not as a number. The bar is indeterminate
 * in that case and shows a real percentage only when `downloadProgress` is
 * actually populated — the resume path below, which fetches from JS, does
 * populate it (the backend sends content-length on every asset:
 * backend/api/routes/updates.ts:401).
 *
 * ─── WHY IT CAN ALWAYS BE DISMISSED ─────────────────────────────────────────
 *
 * A full-screen layer at launch is the shape of the 21.08 bug where the splash
 * looped forever OVER a working app and the owner could not log in. So: a
 * "later" button after DISMISS_AFTER_MS, a hard cap at GIVE_UP_MS, and the
 * download continues underneath either way. This layer can delay the app by a
 * minute at worst, never brick it.
 */

/** How long the user stares at a spinner before being offered a way past it. */
const DISMISS_AFTER_MS = 4000;

/** Hard cap. Past this the overlay leaves regardless; the download keeps going. */
const GIVE_UP_MS = 90_000;

/** Beat between "done" and the restart, so the state is readable rather than a flash. */
const RESTART_DELAY_MS = 1200;

/** A resume after this long is treated as a fresh visit and re-checks for an update. */
const RECHECK_AFTER_BACKGROUND_MS = 15 * 60 * 1000;

export default function UpdateOverlay(): JSX.Element | null {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const { isDownloading, isUpdatePending, downloadProgress } = Updates.useUpdates();

  const [dismissed, setDismissed] = useState<boolean>(false);
  const [canDismiss, setCanDismiss] = useState<boolean>(false);
  const [restarting, setRestarting] = useState<boolean>(false);

  // Only a download the user has actually WATCHED earns an automatic restart.
  // A background one that finished while they were working must not yank the
  // screen out from under them — it applies on the next launch, as before.
  const [watched, setWatched] = useState<boolean>(false);
  const backgroundedAtRef = useRef<number | null>(null);
  const lastCheckRef = useRef<number>(Date.now());

  useEffect(() => {
    if (isDownloading && !dismissed) setWatched(true);
  }, [isDownloading, dismissed]);

  const visible = Updates.isEnabled && !dismissed && (isDownloading || (isUpdatePending && watched));

  // Re-check on a real return to the app. ON_LOAD only ever fires on a cold
  // start, so a phone that keeps 4КУБ open for days never learns an update
  // exists. This path also gives a genuine percentage, because the fetch is
  // ours (see the note above).
  useEffect(() => {
    if (!Updates.isEnabled) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') {
        backgroundedAtRef.current = Date.now();
        return;
      }
      const away = backgroundedAtRef.current === null ? 0 : Date.now() - backgroundedAtRef.current;
      backgroundedAtRef.current = null;
      if (away < RECHECK_AFTER_BACKGROUND_MS) return;
      if (Date.now() - lastCheckRef.current < RECHECK_AFTER_BACKGROUND_MS) return;
      lastCheckRef.current = Date.now();
      void (async () => {
        try {
          const check = await Updates.checkForUpdateAsync();
          if (!check.isAvailable) return;
          setDismissed(false);
          setCanDismiss(false);
          await Updates.fetchUpdateAsync();
        } catch {
          // Offline, or the manifest endpoint is unreachable. Silence is right
          // here: the user did not ask for this and nothing is broken for them.
        }
      })();
    });
    return () => sub.remove();
  }, []);

  // Escape hatches, armed only while the overlay is actually up.
  useEffect(() => {
    if (!visible) return undefined;
    const soft = setTimeout(() => setCanDismiss(true), DISMISS_AFTER_MS);
    const hard = setTimeout(() => setDismissed(true), GIVE_UP_MS);
    return () => {
      clearTimeout(soft);
      clearTimeout(hard);
    };
  }, [visible]);

  const restart = useCallback(() => {
    setRestarting(true);
    void Updates.reloadAsync().catch(() => {
      // reloadAsync can refuse (no pending update, or an embedded-only launch).
      // Leaving the user on a dead "restarting" screen would be the worst
      // outcome of the whole feature, so fall back to the running app.
      setRestarting(false);
      setDismissed(true);
    });
  }, []);

  useEffect(() => {
    if (!visible || !isUpdatePending || restarting) return undefined;
    const timer = setTimeout(restart, RESTART_DELAY_MS);
    return () => clearTimeout(timer);
  }, [visible, isUpdatePending, restarting, restart]);

  if (!visible) return null;

  const pct = typeof downloadProgress === 'number' && downloadProgress > 0
    ? Math.min(99, Math.round(downloadProgress * 100))
    : null;
  const done = isUpdatePending || restarting;

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.title}>{done ? t('updates.readyTitle') : t('updates.title')}</Text>
        <Text style={styles.body}>{done ? t('updates.readyBody') : t('updates.body')}</Text>

        <ProgressBar colors={colors} progress={pct === null ? null : pct / 100} done={done} />

        <Text style={styles.pct}>
          {done ? t('updates.restarting') : pct === null ? t('updates.working') : `${pct}%`}
        </Text>

        {!done && canDismiss ? (
          <TouchableOpacity activeOpacity={0.7} onPress={() => setDismissed(true)}>
            <Text style={styles.later}>{t('updates.later')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Determinate when there is a real number to show, and a looping sweep when
 * there is not. The sweep deliberately does not pretend to advance toward
 * completion — a fake percentage on a download whose size we cannot see would
 * be a lie the user could catch.
 */
function ProgressBar({
  colors,
  progress,
  done,
}: {
  colors: ThemeColors;
  progress: number | null;
  done: boolean;
}): JSX.Element {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const sweep = useRef(new Animated.Value(0)).current;
  const width = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (progress !== null || done) return undefined;
    const loop = Animated.loop(
      Animated.timing(sweep, { toValue: 1, duration: 1100, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, done, sweep]);

  useEffect(() => {
    if (progress === null && !done) return;
    Animated.timing(width, {
      toValue: done ? 1 : progress ?? 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [progress, done, width]);

  if (progress === null && !done) {
    return (
      <View style={styles.track}>
        <Animated.View
          style={[
            styles.sweep,
            {
              transform: [
                {
                  translateX: sweep.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-90, 240],
                  }),
                },
              ],
            },
          ]}
        />
      </View>
    );
  }

  return (
    <View style={styles.track}>
      <Animated.View
        style={[
          styles.fill,
          { width: width.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
        ]}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 200,
    backgroundColor: c.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    gap: spacing.md,
  },
  title: { ...type.title, color: c.text1, textAlign: 'center' },
  body: { ...type.body, color: c.textMuted, textAlign: 'center' },
  track: {
    width: '100%',
    height: 6,
    borderRadius: radius.lg,
    backgroundColor: c.neutralSoft,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.lg, backgroundColor: c.accent },
  sweep: { width: 90, height: '100%', borderRadius: radius.lg, backgroundColor: c.accent },
  pct: { ...type.caption, color: c.textMuted, fontVariant: ['tabular-nums'] },
  later: { ...type.label, color: c.accent, paddingVertical: spacing.sm },
});
