// Sales-funnel chart: one row per stage, each a stacked bar whose full width is proportional to
// the number of deals that reached the stage — so the funnel tapers downward — split into open,
// won and lost. Labels come in pre-formatted; this component carries no strings of its own.
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

export type FunnelBarDatum = {
  key: string;
  /** Stage name. */
  label: string;
  /** Deals that reached this stage — drives the bar width. */
  total: number;
  open: number;
  won: number;
  lost: number;
  countLabel: string;
  valueLabel: string;
  /** Pre-formatted "→ next stage" conversion, or null on the last stage. */
  conversionLabel: string | null;
};

const BAR_HEIGHT = 14;
const SEGMENT_GAP = 1.5;
const MIN_VISIBLE_SEGMENT = 3;

interface FunnelChartProps {
  stages: FunnelBarDatum[];
  conversionLabelPrefix: string;
}

export default function FunnelChart({
  stages,
  conversionLabelPrefix,
}: FunnelChartProps): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [width, setWidth] = useState(0);

  const onLayout = useCallback((event: LayoutChangeEvent): void => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const maxTotal = stages.reduce((max, s) => (s.total > max ? s.total : max), 0);

  return (
    <View onLayout={onLayout}>
      {stages.map((stage, index) => {
        const barWidth = maxTotal > 0 ? (stage.total / maxTotal) * width : 0;
        const segments: Array<{ value: number; color: string }> = [
          { value: stage.open, color: colors.amber },
          { value: stage.won, color: colors.orange },
          { value: stage.lost, color: colors.red },
        ];

        let cursor = 0;
        const drawn = segments.map((segment, segmentIndex) => {
          const raw = stage.total > 0 ? (segment.value / stage.total) * barWidth : 0;
          const segmentWidth = segment.value > 0 ? Math.max(MIN_VISIBLE_SEGMENT, raw) : 0;
          const x = cursor;
          cursor += segmentWidth > 0 ? segmentWidth + SEGMENT_GAP : 0;
          return { x, segmentWidth, color: segment.color, id: `${stage.key}-${segmentIndex}` };
        });

        return (
          <View key={stage.key} style={styles.stageRow}>
            <View style={styles.stageHeader}>
              <Text style={styles.stageName} numberOfLines={1}>{stage.label}</Text>
              <Text style={styles.stageCount}>{stage.countLabel}</Text>
            </View>

            {width > 0 ? (
              <Svg width={width} height={BAR_HEIGHT}>
                <Rect
                  x={0}
                  y={0}
                  width={width}
                  height={BAR_HEIGHT}
                  rx={BAR_HEIGHT / 2}
                  fill={colors.skeleton}
                />
                {drawn.map((segment) =>
                  segment.segmentWidth > 0 ? (
                    <Rect
                      key={segment.id}
                      x={segment.x}
                      y={0}
                      width={segment.segmentWidth}
                      height={BAR_HEIGHT}
                      rx={3}
                      fill={segment.color}
                    />
                  ) : null,
                )}
              </Svg>
            ) : (
              <View style={styles.barPlaceholder} />
            )}

            <Text style={styles.stageValue}>{stage.valueLabel}</Text>

            {stage.conversionLabel !== null && index < stages.length - 1 ? (
              <Text style={styles.conversion}>
                {`↓ ${conversionLabelPrefix}: ${stage.conversionLabel}`}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  stageRow: {
    marginTop: 14,
  },
  stageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 6,
  },
  stageName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: c.text1,
  },
  stageCount: {
    fontSize: 14,
    fontWeight: '700',
    color: c.text1,
  },
  barPlaceholder: {
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    backgroundColor: c.skeleton,
  },
  stageValue: {
    fontSize: 12,
    color: c.amber,
    marginTop: 6,
  },
  conversion: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 8,
  },
});
