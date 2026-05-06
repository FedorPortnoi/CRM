import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';

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
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);

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
    setApiError(null);

    try {
      const response = await fetch(`${API_URL}/contacts/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const parsedBody = (await response.json()) as ErrorResponse;
        setApiError(parsedBody.error.message);
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
      setApiError(err instanceof Error ? err.message : 'Failed to load contact');
    } finally {
      setIsLoading(false);
    }
  }, [id, token]);

  useEffect(() => {
    void loadContact();
  }, [loadContact]);

  const handleSubmit = async (): Promise<void> => {
    if (firstName.trim() === '') {
      setShowFirstNameError(true);
      return;
    }
    if (!original || !token) return;

    setShowFirstNameError(false);
    setApiError(null);
    setIsSubmitting(true);

    const patch = changedFields(form, original);
    if (Object.keys(patch).length === 0) {
      setIsSubmitting(false);
      router.back();
      return;
    }

    try {
      const response = await fetch(`${API_URL}/contacts/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(patch),
      });

      if (response.ok) {
        router.back();
      } else {
        const parsedBody = (await response.json()) as ErrorResponse;
        setApiError(parsedBody.error.message);
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Edit Contact' }} />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {apiError !== null && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{apiError}</Text>
            {!isSubmitting && (
              <TouchableOpacity style={styles.bannerRetry} onPress={() => { void loadContact(); }}>
                <Text style={styles.bannerRetryText}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#1A73E8" />
          </View>
        ) : (
          <>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>First Name *</Text>
              <TextInput
                style={styles.input}
                value={firstName}
                onChangeText={setFirstName}
                autoCapitalize="words"
              />
              {showFirstNameError && (
                <Text style={styles.fieldError}>First name is required</Text>
              )}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Last Name</Text>
              <TextInput
                style={styles.input}
                value={lastName}
                onChangeText={setLastName}
                autoCapitalize="words"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Company</Text>
              <TextInput style={styles.input} value={company} onChangeText={setCompany} />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Phone</Text>
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Notes</Text>
              <TextInput
                style={styles.notesInput}
                value={notes}
                onChangeText={setNotes}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            </View>

            <TouchableOpacity
              style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
              onPress={() => { void handleSubmit(); }}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.submitButtonText}>Save Changes</Text>
              )}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  scrollView: { flex: 1 },
  content: { padding: 16 },
  loadingContainer: { paddingTop: 48 },
  errorBanner: {
    backgroundColor: '#FFEBEE',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  errorBannerText: { color: '#D93025' },
  bannerRetry: { marginTop: 8, alignSelf: 'flex-start' },
  bannerRetryText: { color: '#1A73E8', fontWeight: '600' },
  fieldGroup: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '600', color: '#1A1A1A', marginBottom: 4 },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 15,
    color: '#1A1A1A',
  },
  notesInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    height: 100,
    fontSize: 15,
    color: '#1A1A1A',
  },
  fieldError: { color: '#D93025', fontSize: 12, marginTop: 4 },
  submitButton: {
    backgroundColor: '#1A73E8',
    borderRadius: 8,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 32,
  },
  submitButtonDisabled: { opacity: 0.7 },
  submitButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
