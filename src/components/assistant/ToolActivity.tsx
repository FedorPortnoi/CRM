// What the assistant actually did, shown next to what it says it did.
//
// A model can claim "готово, контакт создан" without having called anything.
// Every turn comes back with the list of tool calls the server really ran, so
// writes are rendered as their own evidence block — action, subject, outcome —
// and reads are collapsed into one muted line underneath. Failed calls stay
// visible with their reason: an action the user believes happened but did not
// is the expensive failure here.
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Search } from 'lucide-react-native';
import {
  assistantToolDoneKey,
  assistantToolLabelKey,
  describeToolArguments,
  isKnownAssistantTool,
  splitToolCalls,
  type AssistantToolCall,
} from '../../utils/assistantTools';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';

interface ToolActivityProps {
  calls: AssistantToolCall[];
}

export default function ToolActivity({ calls }: ToolActivityProps): JSX.Element | null {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  if (calls.length === 0) return null;

  const { writes, reads } = splitToolCalls(calls);

  // Reads repeat a lot (the model pages through contacts); one row per tool with
  // a count reads better than eight identical lines.
  const readCounts = new Map<string, number>();
  for (const call of reads) {
    readCounts.set(call.name, (readCounts.get(call.name) ?? 0) + 1);
  }

  const label = (call: AssistantToolCall): string => {
    if (!isKnownAssistantTool(call.name)) {
      return t('assistant.toolUnknown', { name: call.name });
    }
    return call.ok ? t(assistantToolDoneKey(call.name)) : t(assistantToolLabelKey(call.name));
  };

  return (
    <View style={styles.wrap}>
      {writes.length > 0 ? (
        <View style={styles.actions}>
          <Text style={styles.sectionTitle}>{t('assistant.actionsTitle')}</Text>
          {writes.map((call, index) => {
            const subject = describeToolArguments(call.arguments);
            return (
              <View key={`${call.name}-${String(call.round)}-${String(index)}`} style={styles.actionRow}>
                {call.ok ? (
                  <CheckCircle2
                    size={16}
                    color={colors.success}
                    strokeWidth={2.2}
                    accessibilityLabel={t('assistant.toolOk')}
                  />
                ) : (
                  <AlertTriangle size={16} color={colors.danger} strokeWidth={2.2} />
                )}
                <View style={styles.actionBody}>
                  <Text style={[styles.actionTitle, !call.ok && styles.actionTitleFailed]}>
                    {label(call)}
                  </Text>
                  {subject.length > 0 ? (
                    <Text style={styles.actionSubject} numberOfLines={2}>
                      {subject}
                    </Text>
                  ) : null}
                  {!call.ok ? (
                    <Text style={styles.actionError} numberOfLines={3}>
                      {t('assistant.toolFailed')}
                      {call.error?.message ? ` — ${call.error.message}` : ''}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {readCounts.size > 0 ? (
        <View style={styles.lookups}>
          <View style={styles.lookupHeader}>
            <Search size={13} color={colors.textMuted} strokeWidth={2} />
            <Text style={styles.lookupTitle}>{t('assistant.toolCalls')}</Text>
          </View>
          {Array.from(readCounts.entries()).map(([name, count]) => (
            <Text key={name} style={styles.lookupRow} numberOfLines={1}>
              {isKnownAssistantTool(name)
                ? t(assistantToolLabelKey(name))
                : t('assistant.toolUnknown', { name })}
              {count > 1 ? ` ${t('assistant.lookupRepeat', { count })}` : ''}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  wrap: { alignSelf: 'stretch', marginTop: spacing.sm, gap: spacing.sm },
  actions: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...type.micro,
    color: c.accent,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  actionRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  actionBody: { flex: 1, gap: spacing.xs },
  actionTitle: { ...type.body, color: c.text1 },
  actionTitleFailed: { color: c.danger },
  actionSubject: { ...type.label, color: c.amber },
  actionError: { ...type.caption, color: c.danger },
  lookups: { paddingHorizontal: spacing.xs, gap: spacing.xs },
  lookupHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  lookupTitle: { ...type.micro, color: c.textMuted },
  lookupRow: { ...type.caption, color: c.textMuted, paddingLeft: spacing.lg + spacing.xs },
});
