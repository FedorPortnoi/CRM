import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

/**
 * The animated loading screen.
 *
 * Frame 0 of assets/splash-intro.mp4 is pixel-matched to the static native
 * splash (android splashscreen_logo on #0A0A0A), and the 2.4 s clip is a
 * seamless sine loop — so the sequence native splash → this overlay → app is
 * three states that look like one. The clip is authored in
 * tools/splash-remotion; regenerate the mp4 AND the static assets together or
 * the handoff seam becomes visible.
 *
 * Rules of the overlay:
 *  - it never ADDS waiting: `ready` (session restore finished) gates the exit,
 *    plus a short minimum so a fast boot doesn't strobe a half-played breath;
 *  - reduced motion: no video at all — the static-looking dark frame simply
 *    fades when ready (the system splash already showed the same picture);
 *  - a video error is not a boot error: fall back to the plain dark frame and
 *    leave as scheduled.
 */
const MIN_DISPLAY_MS = 1300;
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
  const mountedAt = useRef(Date.now());
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [videoReadyAt, setVideoReadyAt] = useState<number | null>(null);
  const videoReadyRef = useRef<number | null>(null);
  const finishingRef = useRef(false);

  // A decoder that never paints must not hold the app hostage: if the first
  // frame hasn't landed 4 s after mount, treat the video as failed and let
  // the plain dark frame exit on the ready gate alone.
  useEffect(() => {
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') setVideoFailed(true);
    });
    return () => sub.remove();
  }, [player]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (videoReadyRef.current === null) setVideoFailed(true);
    }, 4000);
    return () => clearTimeout(t);
  }, []);

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
    // reduceMotion === null means the AccessibilityInfo query hasn't resolved
    // yet — scheduling the exit now would misclassify the animated path as
    // reduced-motion (null !== false) and fade the overlay out instantly.
    if (!ready || reduceMotion === null || finishingRef.current) return;
    const animated = reduceMotion === false && !videoFailed;
    // The animated path counts its minimum from the first PAINTED video frame
    // (onReadyForDisplay), not from mount — in dev the asset arrives late and
    // a mount-based clock would expire before the animation was ever seen.
    if (animated && videoReadyAt === null) return; // wait for paint or the 4s safety
    const elapsed = animated ? Date.now() - (videoReadyAt as number) : Number.MAX_SAFE_INTEGER;
    const wait = Math.max(0, (animated ? MIN_DISPLAY_MS : 0) - elapsed);
    const t = setTimeout(() => {
      finishingRef.current = true;
      Animated.timing(opacity, {
        toValue: 0,
        duration: FADE_MS,
        useNativeDriver: true,
      }).start(() => onFinish());
    }, wait);
    return () => clearTimeout(t);
  }, [ready, reduceMotion, videoFailed, videoReadyAt, opacity, onFinish]);

  return (
    <Animated.View pointerEvents="none" style={[styles.fill, { opacity }]}>
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
