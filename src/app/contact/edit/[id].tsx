import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';
import { useCreateMutation } from '../../../hooks/useCreateMutation';
import { useTheme } from '../../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, control } from '../../../theme';
import { Screen, Card, Button, SkeletonText } from '../../../components/ui';

interface Contact {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

type ContactForm = {
  first_name: string;
  last_name: string;
  company: string;
  email: string;
  phone: string;
  notes: string;
};

type ContactPatch = Partial<ContactForm>;

function toForm(contact: Contact): ContactForm {
  return {
    first_name: contact.first_name,
    last_name: contact.last_name ?? '',
    company: contact.company ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    notes: contact.notes ?? '',
  };
}

function changedFields(current: ContactForm, original: ContactForm): ContactPatch {
  const patch: ContactPatch = {};
  const keys: Array<keyof ContactForm> = ['first_name', 'last_name', 'company', 'email', 'phone', 'notes'];

  for (const key of keys) {
    const currentValue = current[key].trim();
    const originalValue = original[key].trim();
    if (currentValue !== originalValue) {
      patch[key] = currentValue;
    }
  }

  return patch;
}

export default function EditContactScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [original, setOriginal] = useState<ContactForm | null>(null);
  const [firstName, setFirstName] = useState<string>('');
  const [lastName, setLastName] = useState<string>('');
  const [company, setCompany] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [phone, setPhone] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [showFirstNameError, setShowFirstNameError] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const form = useMemo<ContactForm>(
    () => ({
      first_name: firstName,
      last_name: lastName,
      company,
      email,
      phone,
      notes,
    }),
    [firstName, lastName, company, email, phone, notes],
  );

  const loadContact = useCallback(async (): Promise<void> => {
    if (!token) return;
    setIsLoading(true);
    setLoadError(null);

    try {
      const response = await fetch(`${API_URL}/contacts/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const parsedBody = (await response.json()) as ErrorResponse;
        setLoadError(parsedBody.error.message);
        return;
      }

      const responseBody = (await response.json()) as { data: Contact };
      const loadedForm = toForm(responseBody.data);
      setOriginal(loadedForm);
      setFirstName(loadedForm.first_name);
      setLastName(loadedForm.last_name);
      setCompany(loadedForm.company);
      setEmail(loadedForm.email);
      setPhone(loadedForm.phone);
      setNotes(loadedForm.notes);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить контакт');
    } finally {
      setIsLoading(false);
    }
  }, [id, token]);

  useEffect(() => {
    void loadContact();
  }, [loadContact]);

  const { isSubmitting, apiError, submit } = useCreateMutation<ContactPatch, Contact>({
    endpoint: `${API_URL}/contacts/${id}`,
    method: 'PATCH',
    token: token ?? '',
    validate: () => {
      if (firstName.trim() === '') {
        setShowFirstNameError(true);
        return false;
      }
      setShowFirstNameError(false);
      return true;
    },
    buildPayload: () => changedFields(form, original!),
    onSuccess: () => { router.back(); },
    fallbackErrorMessage: 'Network error',
  });

  const handleSubmit = (): void => {
    if (!original) return;
    if (Object.keys(changedFields(form, original)).length === 0) {
      router.back();
      return;
    }
    void submit();
  };

  return (
    <>
      <Stack.Screen options={{ title: t('contacts.editTitle') }} />
      <Screen contentContainerStyle={styles.contentPad}>
        {(loadError ?? apiError) !== null ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{loadError ?? apiError}</Text>
            {loadError !== null ? (
              <Button
                title={t('common.retry')}
                variant="ghost"
                size="sm"
                onPress={() => { void loadContact(); }}
                style={styles.bannerRetry}
              />
            ) : null}
          </View>
        ) : null}

        {isLoading ? (
          <>
            <Card style={styles.cardSpacing}>
              <SkeletonText lines={2} lastLineWidth="60%" />
            </Card>
            <Card style={styles.cardSpacing}>
              <SkeletonText lines={3} lastLineWidth="50%" />
            </Card>
            <Card>
              <SkeletonText lines={2} lastLineWidth="70%" />
            </Card>
          </>
        ) : (
          <>
            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('contacts.firstName')} *</Text>
                <TextInput
                  style={styles.input}
                  value={firstName}
                  onChangeText={setFirstName}
                  autoCapitalize="words"
                  placeholderTextColor={colors.placeholder}
                />
                {showFirstNameError ? (
                  <Text style={styles.fieldError}>{t('contacts.firstNameRequired')}</Text>
                ) : null}
              </View>

              <View style={styles.fieldGroupLast}>
                <Text style={styles.label}>{t('contacts.lastName')}</Text>
                <TextInput
                  style={styles.input}
                  value={lastName}
                  onChangeText={setLastName}
                  autoCapitalize="words"
                  placeholderTextColor={colors.placeholder}
                />
              </View>
            </Card>

            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('contacts.company')}</Text>
                <TextInput
                  style={styles.input}
                  value={company}
                  onChangeText={setCompany}
                  placeholderTextColor={colors.placeholder}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('contacts.email')}</Text>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  placeholderTextColor={colors.placeholder}
                />
              </View>

              <View style={styles.fieldGroupLast}>
                <Text style={styles.label}>{t('contacts.phone')}</Text>
                <TextInput
                  style={styles.input}
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  placeholderTextColor={colors.placeholder}
                />
              </View>
            </Card>

            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroupLast}>
                <Text style={styles.label}>{t('contacts.notes')}</Text>
                <TextInput
                  style={styles.notesInput}
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                  placeholderTextColor={colors.placeholder}
                />
              </View>
            </Card>

            <Button
              title={t('common.save')}
              onPress={handleSubmit}
              loading={isSubmitting}
              disabled={isSubmitting}
              block
            />
          </>
        )}
      </Screen>
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  contentPad: {
    paddingTop: spacing.lg,
  },
  cardSpacing: {
    marginBottom: spacing.lg,
  },
  errorBanner: {
    backgroundColor: c.dangerSoft,
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
  },
  errorBannerText: { ...type.body, color: c.danger },
  bannerRetry: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  fieldGroup: { marginBottom: spacing.md },
  fieldGroupLast: { marginBottom: 0 },
  label: { ...type.label, color: c.text1, marginBottom: spacing.xs },
  input: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: control.md,
    ...type.body,
    color: c.text1,
  },
  notesInput: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    height: 100,
    ...type.body,
    color: c.text1,
  },
  fieldError: { ...type.caption, color: c.danger, marginTop: spacing.xs },
});
