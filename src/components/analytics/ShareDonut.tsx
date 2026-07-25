// Donut for two-or-three-way splits (won vs lost). Segments are drawn as stroked arcs rather
// than dash offsets so a single 100% segment still renders correctly.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { describeArc } from './geometry';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

export type DonutSegment = {
  key: string;
  value: number;
  color: string;
};

interface ShareDonutProps {
  segments: DonutSegment[];
  /** Pre-formatted headline shown inside the ring. */
  centerValue: string;
  centerLabel: string;
  size?: number;
  strokeWidth?: number;
}

export default function ShareDonut({
  segments,
  centerValue,
  centerLabel,
  size = 168,
  strokeWidth = 20,
}: ShareDonutProps): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);

  let cursor = 0;
  const arcs = segments.map((segment) => {
    const value = Math.max(0, segment.value);
    const sweep = total > 0 ? (value / total) * 360 : 0;
    const start = cursor;
    cursor += sweep;
    return { key: segment.key, color: segment.color, d: describeArc(center, center, radius, start, start + sweep) };
  });

  return (
    <View style={styles.wrap}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <Circle
            cx={center}
            cy={center}
            r={radius}
            stroke={colors.skeleton}
            strokeWidth={strokeWidth}
            fill="none"
          />
          {arcs.map((arc) =>
            arc.d ? (
              <Path
                key={arc.key}
                d={arc.d}
                stroke={arc.color}
                strokeWidth={strokeWidth}
                strokeLinecap="butt"
                fill="none"
              />
            ) : null,
          )}
        </Svg>
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.centerValue} numberOfLines={1} adjustsFontSizeToFit>
            {centerValue}
          </Text>
          <Text style={styles.centerLabel} numberOfLines={2}>{centerLabel}</Text>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  wrap: {
    alignItems: 'center',
    marginVertical: 12,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 34,
  },
  centerValue: {
    fontSize: 24,
    fontWeight: '700',
    color: c.text1,
  },
  centerLabel: {
    fontSize: 11,
    color: c.textMuted,
    textAlign: 'center',
    marginTop: 2,
  },
});
