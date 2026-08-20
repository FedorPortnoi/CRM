import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, StyleSheet } from 'react-native';
import { SplashScreen } from 'expo-router';
import { VideoView, useVideoPlayer } from 'expo-video';

// This has to run while the route module is being evaluated, before Expo
// Router gets its first chance to auto-hide the native launch screen. If the
// optional native module is unavailable (web/tests), Router's implementation
// resolves harmlessly; the catch also keeps a native failure from becoming an
// unhandled rejection during startup.
void SplashScreen.preventAutoHideAsync().catch(() => {});

let nativeSplashHideStarted = false;

/** Hide the native launch screen once, without letting a native failure break boot. */
function hideNativeSplashOnce(): void {
  if (nativeSplashHideStarted) return;
  nativeSplashHideStarted = true;
  void SplashScreen.hideAsync().catch(() => {});
}

/**
 * The animated loading screen.
 *
 * Frame 0 of assets/splash-intro.mp4 is pixel-matched to the static native
 * splash (android splashscreen_logo on #0A0A0A), and the 5.7 s clip is a
 * seamless sine loop — so the sequence native splash → this overlay → app is
 * three states that look like one. The clip is authored in
 * tools/splash-remotion; regenerate the mp4 AND the static assets together or
 * the handoff seam becomes visible.
 *
 * Rules of the overlay:
 *  - `ready` (session restore finished) gates the exit, together with a short
 *    display minimum so a fast boot doesn't strobe a half-played breath;
 *  - reduced motion: no animated VideoView is shown — the dark fallback simply
 *    fades when ready (the system splash already showed the same picture);
 *  - a video error is not a boot error: fall back to the plain dark frame and
 *    leave as scheduled.
 *
 * The native splash is held until the first video frame has actually rendered.
 * On reduced motion or decoder failure, it is held until the dark fallback has
 * laid out instead, so neither path exposes an unpainted React root.
 */
const MIN_DISPLAY_MS = 3600;
const FADE_MS = 450;

type Props = {
  ready: boolean;
  onFinish: () => void;
};

export default function AnimatedSplash({ ready, onFinish }: Props) {
  // expo-video, not the deprecated expo-av: this app runs the New
  // Architecture, where expo-av's <Video> mounts but never renders a frame.
  const player = useVideoPlayer(require('../../assets/splash-intro.mp4'), (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  const opacity = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [videoReadyAt, setVideoReadyAt] = useState<number | null>(null);
  const [fallbackLaidOut, setFallbackLaidOut] = useState(false);
  // State, not only the ref: pointerEvents below must flip on this transition,
  // and a ref write does not re-render.
  const [finishing, setFinishing] = useState(false);
  const videoReadyRef = useRef<number | null>(null);
  const finishingRef = useRef(false);

  useEffect(() => {
    // The subscription starts a commit after the player was created, so an
    // error that fired in that gap would be missed — ask once before listening.
    if (player.status === 'error') {
      setVideoFailed(true);
      return;
    }
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') setVideoFailed(true);
    });
    return () => sub.remove();
  }, [player]);

  // A decoder that never paints must not hold the app hostage: if the first
  // frame hasn't landed 4 s after the VideoView could actually mount, treat
  // the video as failed and let the plain dark frame exit on the ready gate
  // alone. Gated on reduceMotion === false, not on component mount: the
  // VideoView itself only mounts once the AccessibilityInfo query resolves,
  // so a mount-based clock would quietly bill that wait to the decoder.
  useEffect(() => {
    if (reduceMotion !== false) return;
    const t = setTimeout(() => {
      if (videoReadyRef.current === null) setVideoFailed(true);
    }, 4000);
    return () => clearTimeout(t);
  }, [reduceMotion]);

  // expo-video pauses playback when the app backgrounds and stays paused on
  // return — without this, switching away mid-splash comes back to a frozen
  // frame for the rest of the display minimum.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      try {
        player.play();
      } catch {
        // Player already released — the splash is on its way out.
      }
    });
    return () => sub.remove();
  }, [player]);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => active && setReduceMotion(v))
      .catch(() => active && setReduceMotion(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (fallbackLaidOut && (reduceMotion === true || videoFailed)) {
      hideNativeSplashOnce();
    }
  }, [fallbackLaidOut, reduceMotion, videoFailed]);

  useEffect(() => {
    // reduceMotion === null means the AccessibilityInfo query hasn't resolved
    // yet — scheduling the exit now would misclassify the animated path as
    // reduced-motion (null !== false) and fade the overlay out instantly.
    if (!ready || reduceMotion === null || finishingRef.current) return;
    const animated = reduceMotion === false && !videoFailed;
    // The animated path counts its minimum from the first PAINTED video frame
    // (onFirstFrameRender), not from mount — in dev the asset arrives late and
    // a mount-based clock would expire before the animation was ever seen.
    if (animated && videoReadyAt === null) return; // wait for paint or the 4s safety
    const elapsed = animated ? Date.now() - (videoReadyAt as number) : Number.MAX_SAFE_INTEGER;
    const wait = Math.max(0, (animated ? MIN_DISPLAY_MS : 0) - elapsed);
    const t = setTimeout(() => {
      finishingRef.current = true;
      setFinishing(true);
      Animated.timing(opacity, {
        toValue: 0,
        duration: FADE_MS,
        useNativeDriver: true,
      }).start(() => onFinish());
    }, wait);
    return () => clearTimeout(t);
  }, [ready, reduceMotion, videoFailed, videoReadyAt, opacity, onFinish]);

  return (
    // Touches are BLOCKED while the splash is opaque: the boot routing lands
    // on a real, interactive screen well inside the display minimum, and a
    // pass-through overlay let impatient taps press invisible controls
    // underneath. Only once the fade starts does the overlay get out of the
    // way, so the app becomes usable the moment it becomes visible.
    <Animated.View
      pointerEvents={finishing ? 'none' : 'auto'}
      style={[styles.fill, { opacity }]}
      onLayout={() => setFallbackLaidOut(true)}
    >
      {reduceMotion === false && !videoFailed ? (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          onFirstFrameRender={() => {
            if (videoReadyRef.current === null) {
              videoReadyRef.current = Date.now();
              setVideoReadyAt(videoReadyRef.current);
            }
            hideNativeSplashOnce();
          }}
        />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0A0A0A',
    zIndex: 999,
    elevation: 999,
  },
});
