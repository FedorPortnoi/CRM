// Vertical bar chart for the revenue series. Deliberately minimal: no axis numbers on the bars
// (money in RUB is far too wide for a 30pt bar on a phone) — the caller renders the selected
// bucket's figures underneath instead. Tapping a bar selects it.
import React, { useCallback, useState } from 'react';
import { View, ScrollView, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Svg, { Rect, Line, Text as SvgText } from 'react-native-svg';
import { useTheme } from '../../hooks/useTheme';

export type BarDatum = {
  key: string;
  /** Short axis label, already formatted by the caller through the market profile. */
  label: string;
  value: number;
};

const MIN_SLOT_WIDTH = 34;
const LABEL_BAND = 20;
const MIN_VISIBLE_BAR = 2;

interface BarChartProps {
  data: BarDatum[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  height?: number;
}

export default function BarChart({
  data,
  selectedKey,
  onSelect,
  height = 160,
}: BarChartProps): JSX.Element {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);

  const onLayout = useCallback((event: LayoutChangeEvent): void => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const slot = data.length > 0 ? Math.max(MIN_SLOT_WIDTH, width / data.length) : MIN_SLOT_WIDTH;
  const chartWidth = Math.max(width, slot * data.length);
  const plotHeight = height - LABEL_BAND;
  const maxValue = data.reduce((max, d) => (d.value > max ? d.value : max), 0);
  const barWidth = Math.max(8, Math.round(slot * 0.56));

  // Thin out the axis labels until they stop colliding; the selected bucket always keeps its own.
  const labelSlots = Math.max(1, Math.floor(chartWidth / 56));
  const labelStride = Math.max(1, Math.ceil(data.length / labelSlots));

  const chart = width > 0 && data.length > 0 ? (
    <Svg width={chartWidth} height={height}>
      <Line
        x1={0}
        y1={plotHeight / 2}
        x2={chartWidth}
        y2={plotHeight / 2}
        stroke={colors.border}
        strokeWidth={1}
      />
      <Line
        x1={0}
        y1={plotHeight}
        x2={chartWidth}
        y2={plotHeight}
        stroke={colors.borderStrong}
        strokeWidth={1}
      />
      {data.map((datum, index) => {
        const isSelected = datum.key === selectedKey;
        const scaled = maxValue > 0 ? (datum.value / maxValue) * plotHeight : 0;
        const barHeight = datum.value > 0 ? Math.max(MIN_VISIBLE_BAR, scaled) : 0;
        const x = index * slot + (slot - barWidth) / 2;
        const showLabel = index % labelStride === 0 || isSelected;

        return (
          <React.Fragment key={datum.key}>
            {barHeight > 0 ? (
              <Rect
                x={x}
                y={plotHeight - barHeight}
                width={barWidth}
                height={barHeight}
                rx={3}
                fill={isSelected ? colors.orange : colors.amber}
                fillOpacity={isSelected ? 1 : 0.45}
              />
            ) : null}
            {showLabel ? (
              <SvgText
                x={index * slot + slot / 2}
                y={height - 6}
                fontSize={10}
                fontWeight={isSelected ? '700' : '400'}
                fill={isSelected ? colors.orange : colors.textMuted}
                textAnchor="middle"
              >
                {datum.label}
              </SvgText>
            ) : null}
            {/* Full-slot transparent target so thin bars stay tappable. */}
            <Rect
              x={index * slot}
              y={0}
              width={slot}
              height={height}
              fill={colors.orange}
              fillOpacity={0}
              onPress={() => onSelect(datum.key)}
            />
          </React.Fragment>
        );
      })}
    </Svg>
  ) : null;

  return (
    <View style={[styles.wrap, { minHeight: height }]} onLayout={onLayout}>
      {chartWidth > width ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {chart}
        </ScrollView>
      ) : (
        chart
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
  },
});
