// Half-circle gauge for the Pipeline Health Score. The value is always presented as the score
// itself — the caller supplies the already-formatted label, and the copy around it must never
// call this a win rate.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { describeArc, safeFraction } from './geometry';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

const START_ANGLE = 270; // left end of the arc
const SWEEP = 180;

interface ScoreGaugeProps {
  /** 0..100 */
  score: number;
  /** Pre-formatted score, e.g. "62,5%". */
  valueLabel: string;
  caption: string;
  color: string;
  size?: number;
  strokeWidth?: number;
}

export default function ScoreGauge({
  score,
  valueLabel,
  caption,
  color,
  size = 200,
  strokeWidth = 16,
}: ScoreGaugeProps): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const radius = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = radius + strokeWidth / 2;
  const svgHeight = cy + strokeWidth / 2;

  const fraction = safeFraction(score, 100);
  const trackPath = describeArc(cx, cy, radius, START_ANGLE, START_ANGLE + SWEEP);
  const valuePath = describeArc(cx, cy, radius, START_ANGLE, START_ANGLE + SWEEP * fraction);

  return (
    <View style={styles.wrap}>
      <View style={{ width: size, height: svgHeight }}>
        <Svg width={size} height={svgHeight}>
          <Path
            d={trackPath}
            stroke={colors.skeleton}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            fill="none"
          />
          {valuePath ? (
            <Path
              d={valuePath}
              stroke={color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              fill="none"
            />
          ) : null}
        </Svg>
        <View style={styles.overlay} pointerEvents="none">
          <Text style={[styles.value, { color }]} numberOfLines={1} adjustsFontSizeToFit>
            {valueLabel}
          </Text>
        </View>
      </View>
      <Text style={styles.caption}>{caption}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  wrap: {
    alignItems: 'center',
    marginTop: 12,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  value: {
    fontSize: 30,
    fontWeight: '700',
  },
  caption: {
    fontSize: 12,
    fontWeight: '600',
    color: c.amber,
    marginTop: 10,
    textAlign: 'center',
  },
});
