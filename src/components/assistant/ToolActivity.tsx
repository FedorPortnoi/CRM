// What the assistant actually did, shown next to what it says it did.
//
// A model can claim "готово, контакт создан" without having called anything.
// Every turn comes back with the list of tool calls the server really ran, so
// writes are rendered as their own evidence block — action, subject, outcome —
// and reads are collapsed into one muted line underneath. Failed calls stay
// visible with their reason: an action the user believes happened but did not
// is the expensive failure here.
import React from 'react';
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
import { ThemeColors } from '../../theme';

interface ToolActivityProps {
  calls: AssistantToolCall[];
}

export default function ToolActivity({ calls }: ToolActivityProps): JSX.Element | null {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

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
                    color={colors.orange}
                    strokeWidth={2.2}
                    accessibilityLabel={t('assistant.toolOk')}
                  />
                ) : (
                  <AlertTriangle size={16} color={colors.red} strokeWidth={2.2} />
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
  wrap: { alignSelf: 'stretch', marginTop: 8, gap: 8 },
  actions: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.bgPanel,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: c.orange,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  actionRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  actionBody: { flex: 1, gap: 2 },
  actionTitle: { fontSize: 14, fontWeight: '600', color: c.text1, lineHeight: 19 },
  actionTitleFailed: { color: c.red },
  actionSubject: { fontSize: 13, color: c.amber, lineHeight: 18 },
  actionError: { fontSize: 12, color: c.red, lineHeight: 17 },
  lookups: { paddingHorizontal: 2, gap: 2 },
  lookupHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lookupTitle: { fontSize: 11, color: c.textMuted, fontWeight: '600' },
  lookupRow: { fontSize: 12, color: c.textMuted, lineHeight: 17, paddingLeft: 19 },
});
