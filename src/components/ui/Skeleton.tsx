import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Animated,
  AccessibilityInfo,
  StyleSheet,
  StyleProp,
  ViewStyle,
  DimensionValue,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius } from '../../theme';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  /** Corner radius. Default radius.sm. */
  rounded?: number;
  style?: StyleProp<ViewStyle>;
}

/** Default bar height — one line of body text. */
const LINE_HEIGHT = spacing.md;

function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setReduced(v); })
      .catch(() => { /* default to animating */ });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { alive = false; sub.remove(); };
  }, []);

  return reduced;
}

export default function Skeleton({
  width = '100%',
  height = LINE_HEIGHT,
  rounded = radius.sm,
  style,
}: SkeletonProps): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);

  const box: StyleProp<ViewStyle> = [
    styles.block,
    { width, height, borderRadius: rounded },
    style,
  ];

  if (reduceMotion) {
    return <View style={box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
  }

  return (
    <Animated.View
      style={[box, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] }) }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

export interface SkeletonTextProps {
  /** Number of lines. Default 3. */
  lines?: number;
  /** Width of the final, short line. Default '60%'. */
  lastLineWidth?: DimensionValue;
  style?: StyleProp<ViewStyle>;
}

export function SkeletonText({
  lines = 3,
  lastLineWidth = '60%',
  style,
}: SkeletonTextProps): JSX.Element {
  return (
    <View style={[stack.wrap, style]}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? lastLineWidth : '100%'} />
      ))}
    </View>
  );
}

const stack = StyleSheet.create({
  wrap: { gap: spacing.sm },
});

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  block: { backgroundColor: c.skeleton },
});
