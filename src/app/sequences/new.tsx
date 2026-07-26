// Create an email sequence. Owner/admin only (the server enforces it too).
//
// Backend: POST /api/v1/sequences  { name, description?, status?, steps? }
// i18n:    sequences.*
//
// The form always writes the first step. A sequence with no steps is refused at enrollment
// (SEQUENCE_HAS_NO_STEPS), so shipping the operator a saved-but-unusable sequence would only
// move the failure later. Steps 2..N are added on the sequence screen.
//
// It is created as a draft on purpose: nothing is mailed until someone presses «Запустить».
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import {
  MAX_STEP_DELAY_DAYS,
  useCreateSequence,
  useEmailTemplateOptions,
} from '../../hooks/useSequences';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

export default function NewSequenceScreen(): JSX.Element {
  const { t } = useTranslation();
  const role = useUserStore((s) => s.user?.role);
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const canManage = role === 'owner' || role === 'admin';

  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [mode, setMode] = useState<'inline' | 'template'>('inline');
  const [delay, setDelay] = useState<string>('0');
  const [subject, setSubject] = useState<string>('');
  const [body, setBody] = useState<string>('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createSequence = useCreateSequence();
  const templatesQuery = useEmailTemplateOptions(canManage);
  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);

  const submit = useCallback((): void => {
    const trimmedName = name.trim();
    if (trimmedName === '') {
      setError(t('sequences.nameRequired'));
      return;
    }

    const delayDays = Number.parseInt(delay.trim() === '' ? '0' : delay.trim(), 10);
    if (!Number.isFinite(delayDays) || delayDays < 0 || delayDays > MAX_STEP_DELAY_DAYS) {
      setError(t('sequences.stepDelayInvalid', { max: MAX_STEP_DELAY_DAYS }));
      return;
    }

    if (mode === 'template' && !templateId) {
      setError(t('sequences.stepTemplateRequired'));
      return;
    }

    if (mode === 'inline' && (subject.trim() === '' || body.trim() === '')) {
      setError(t('sequences.stepContentRequired'));
      return;
    }

    setError(null);
    createSequence.mutate(
      {
        name: trimmedName,
        description: description.trim() === '' ? null : description.trim(),
        status: 'draft',
        steps: [
          mode === 'template'
            ? { delay_days: delayDays, template_id: templateId }
            : { delay_days: delayDays, subject: subject.trim(), body: body.trim() },
        ],
      },
      {
        onSuccess: (created) => router.replace(`/sequences/${created.id}` as never),
        onError: () => setError(t('sequences.failedToCreate')),
      },
    );
  }, [name, description, delay, mode, templateId, subject, body, createSequence, t]);

  if (!canManage) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t('sequences.newTitle') }} />
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{t('sequences.adminOnly')}</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t('sequences.newTitle') }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.subtitle}>{t('sequences.createdAsDraft')}</Text>
        <Text style={styles.legalNote}>{t('sequences.consentNote')}</Text>

        <Text style={styles.label}>{t('sequences.nameLabel')} *</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={(value) => {
            setName(value);
            setError(null);
          }}
          placeholder={t('sequences.namePlaceholder')}
          placeholderTextColor={colors.placeholder}
        />

        <Text style={styles.label}>{t('sequences.descriptionLabel')}</Text>
        <TextInput
          style={styles.input}
          value={description}
          onChangeText={setDescription}
          placeholder={t('sequences.descriptionPlaceholder')}
          placeholderTextColor={colors.placeholder}
        />

        <Text style={styles.sectionTitle}>{t('sequences.firstStepTitle')}</Text>
        <Text style={styles.fieldHint}>{t('sequences.firstStepHint')}</Text>

        <Text style={styles.label}>{t('sequences.stepDelayLabel')}</Text>
        <TextInput
          style={styles.input}
          value={delay}
          onChangeText={setDelay}
          keyboardType="number-pad"
          placeholder="0"
          placeholderTextColor={colors.placeholder}
        />
        <Text style={styles.fieldHint}>{t('sequences.stepDelayFirstHint')}</Text>

        <View style={styles.modeRow}>
          <TouchableOpacity
            style={[styles.modePill, mode === 'inline' && styles.modePillActive]}
            onPress={() => setMode('inline')}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === 'inline' }}
          >
            <Text style={[styles.modePillText, mode === 'inline' && styles.modePillTextActive]}>
              {t('sequences.stepWriteInline')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modePill, mode === 'template' && styles.modePillActive]}
            onPress={() => setMode('template')}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === 'template' }}
          >
            <Text style={[styles.modePillText, mode === 'template' && styles.modePillTextActive]}>
              {t('sequences.stepUseTemplate')}
            </Text>
          </TouchableOpacity>
        </View>

        {mode === 'template' ? (
          templatesQuery.isPending ? (
            <ActivityIndicator color={colors.orange} style={styles.inlineLoader} />
          ) : templates.length === 0 ? (
            <Text style={styles.fieldHint}>{t('sequences.noTemplates')}</Text>
          ) : (
            templates.map((template) => (
              <TouchableOpacity
                key={template.id}
                style={[styles.templateRow, templateId === template.id && styles.templateRowSelected]}
                onPress={() => {
                  setTemplateId(template.id);
                  setError(null);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: templateId === template.id }}
              >
                <Text style={styles.templateName}>{template.name}</Text>
                <Text style={styles.templateSubject} numberOfLines={1}>{template.subject}</Text>
              </TouchableOpacity>
            ))
          )
        ) : (
          <>
            <Text style={styles.label}>{t('sequences.stepSubjectLabel')}</Text>
            <TextInput
              style={styles.input}
              value={subject}
              onChangeText={(value) => {
                setSubject(value);
                setError(null);
              }}
              placeholder={t('sequences.stepSubjectPlaceholder')}
              placeholderTextColor={colors.placeholder}
            />
            <Text style={styles.label}>{t('sequences.stepBodyLabel')}</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={body}
              onChangeText={(value) => {
                setBody(value);
                setError(null);
              }}
              placeholder={t('sequences.stepBodyPlaceholder')}
              placeholderTextColor={colors.placeholder}
              multiline
              textAlignVertical="top"
            />
            <Text style={styles.fieldHint}>{t('sequences.stepBodyHint')}</Text>
          </>
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <TouchableOpacity
          style={styles.submitButton}
          onPress={submit}
          disabled={createSequence.isPending}
          accessibilityRole="button"
        >
          {createSequence.isPending ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.submitButtonText}>{t('sequences.createAction')}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, paddingBottom: 48 },
  subtitle: { fontSize: 14, color: c.amber, lineHeight: 20 },
  legalNote: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginTop: 6 },
  notice: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
    padding: 14,
  },
  noticeText: { color: c.amber, fontSize: 14, lineHeight: 20 },
  label: { fontSize: 14, fontWeight: '600', color: c.text1, marginTop: 16, marginBottom: 6 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text1, marginTop: 26 },
  fieldHint: { fontSize: 12, color: c.textMuted, marginTop: 6, lineHeight: 17 },
  input: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: c.text1,
  },
  textArea: { minHeight: 140 },
  inlineLoader: { marginVertical: 12 },
  modeRow: { flexDirection: 'row', gap: 8, marginTop: 18 },
  modePill: {
    flex: 1,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 9,
    alignItems: 'center',
  },
  modePillActive: { backgroundColor: c.orange, borderColor: c.orange },
  modePillText: { fontSize: 13, color: c.text1 },
  modePillTextActive: { color: '#FFFFFF', fontWeight: '700' },
  templateRow: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    padding: 12,
    marginTop: 8,
  },
  templateRowSelected: { borderColor: c.orange, backgroundColor: 'rgba(204,120,92,0.08)' },
  templateName: { fontSize: 14, fontWeight: '600', color: c.text1 },
  templateSubject: { fontSize: 12, color: c.amber, marginTop: 2 },
  errorText: { color: c.red, fontSize: 13, marginTop: 14, lineHeight: 18 },
  submitButton: {
    backgroundColor: c.orange,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 28,
  },
  submitButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
