import { useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { enqueue } from '../../utils/offlineQueue';
import { useCreateMutation } from '../../hooks/useCreateMutation';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Button } from '../../components/ui';

type RouteParamValue = string | string[] | undefined;

type NewContactParams = {
  phone?: string | string[];
  capture_id?: string | string[];
};

function firstRouteParam(value: RouteParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function matchCaptureToContact(captureId: string, contactId: string, authToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/captures/${captureId}/match`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contact_id: contactId }),
    });

    return response.ok || response.status === 404 || response.status === 422;
  } catch {
    return false;
  }
}

async function queueCaptureMatch(captureId: string, contactId: string): Promise<void> {
  await enqueue({
    url: `${API_URL}/captures/${captureId}/match`,
    method: 'POST',
    body: JSON.stringify({ contact_id: contactId }),
  });
}

async function queueContactCreation(
  body: Record<string, string>,
  captureId: string | null,
): Promise<void> {
  await enqueue({
    url: `${API_URL}/contacts`,
    method: 'POST',
    body: JSON.stringify(body),
    followUp: captureId
      ? {
          kind: 'matchCaptureToCreatedContact',
          url: `${API_URL}/captures/${captureId}/match`,
          method: 'POST',
        }
      : undefined,
  });
}

export default function NewContactScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const token = useUserStore((s) => s.token);
  const { phone: routePhone, capture_id: routeCaptureId } = useLocalSearchParams<NewContactParams>();
  const captureId = firstRouteParam(routeCaptureId)?.trim() || null;

  const [firstName, setFirstName] = useState<string>('');
  const [lastName, setLastName] = useState<string>('');
  const [company, setCompany] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [phone, setPhone] = useState<string>(() => firstRouteParam(routePhone) ?? '');
  const [notes, setNotes] = useState<string>('');
  const [showFirstNameError, setShowFirstNameError] = useState<boolean>(false);

  const styles = makeStyles(colors);

  const { isSubmitting, apiError, submit } = useCreateMutation<Record<string, string>, { id: string }>({
    endpoint: `${API_URL}/contacts`,
    token: token ?? '',
    validate: () => {
      if (firstName.trim() === '') {
        setShowFirstNameError(true);
        return false;
      }
      setShowFirstNameError(false);
      return true;
    },
    buildPayload: () => {
      const body: Record<string, string> = { first_name: firstName.trim() };
      if (lastName.trim() !== '') body.last_name = lastName.trim();
      if (company.trim() !== '') body.company = company.trim();
      if (email.trim() !== '') body.email = email.trim();
      if (phone.trim() !== '') body.phone = phone.trim();
      if (notes.trim() !== '') body.notes = notes.trim();
      return body;
    },
    onSuccess: (data, queued) => {
      if (queued) {
        void queueContactCreation(
          { first_name: firstName.trim() },
          captureId,
        );
        router.replace('/(tabs)/contacts');
        return;
      }
      const newContactId = data.id;
      if (captureId && token) {
        void matchCaptureToContact(captureId, newContactId, token).then((matched) => {
          if (!matched) void queueCaptureMatch(captureId, newContactId);
        });
      }
      router.replace({ pathname: '/contact/[id]', params: { id: newContactId } });
    },
    fallbackErrorMessage: t('contacts.failedToCreate'),
  });

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('contacts.new') }} />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {apiError !== null && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{apiError}</Text>
          </View>
        )}

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('contacts.firstName')} *</Text>
          <TextInput
            style={styles.input}
            value={firstName}
            onChangeText={setFirstName}
            autoCapitalize="words"
          />
          {showFirstNameError && (
            <Text style={styles.fieldError}>{t('contacts.firstNameRequired')}</Text>
          )}
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('contacts.lastName')}</Text>
          <TextInput
            style={styles.input}
            value={lastName}
            onChangeText={setLastName}
            autoCapitalize="words"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('contacts.company')}</Text>
          <TextInput style={styles.input} value={company} onChangeText={setCompany} />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('contacts.email')}</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('contacts.phone')}</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('contacts.notes')}</Text>
          <TextInput
            style={styles.notesInput}
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        <Button
          title={t('contacts.new')}
          onPress={() => { void submit(); }}
          loading={isSubmitting}
          disabled={isSubmitting}
          block
          style={styles.submitButton}
        />
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scrollView: { flex: 1 },
  content: { padding: spacing.lg },
  errorBanner: {
    backgroundColor: c.dangerSoft,
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
  },
  errorBannerText: { color: c.danger },
  fieldGroup: { marginBottom: spacing.lg },
  label: { ...type.label, color: c.text1, marginBottom: spacing.xs },
  input: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 16,
    color: c.text1,
  },
  notesInput: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    height: 100,
    fontSize: 16,
    color: c.text1,
  },
  fieldError: { color: c.danger, fontSize: 12, marginTop: spacing.xs },
  submitButton: {
    marginTop: spacing.xl,
    marginBottom: spacing.xxl,
  },
});
