import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { sendOrQueueMutation } from '../../utils/offlineMutation';

interface CreateContactResponse {
  data: { id: string };
}

interface ErrorResponse {
  error: { code: string; message: string };
}

type RouteParamValue = string | string[] | undefined;

type NewContactParams = {
  phone?: string | string[];
  capture_id?: string | string[];
};

function firstRouteParam(value: RouteParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function matchCaptureToContact(captureId: string, contactId: string, authToken: string): Promise<void> {
  try {
    await fetch(`${API_URL}/captures/${captureId}/match`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contact_id: contactId }),
    });
  } catch {
    // Matching the capture is best-effort after contact creation.
  }
}

export default function NewContactScreen(): JSX.Element {
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
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const handleSubmit = async (): Promise<void> => {
    if (firstName.trim() === '') {
      setShowFirstNameError(true);
      return;
    }
    setShowFirstNameError(false);
    setIsSubmitting(true);

    const body: Record<string, string> = { first_name: firstName.trim() };
    if (lastName.trim() !== '') body.last_name = lastName.trim();
    if (company.trim() !== '') body.company = company.trim();
    if (email.trim() !== '') body.email = email.trim();
    if (phone.trim() !== '') body.phone = phone.trim();
    if (notes.trim() !== '') body.notes = notes.trim();

    try {
      const result = await sendOrQueueMutation({
        url: `${API_URL}/contacts`,
        method: 'POST',
        token: token ?? '',
        body,
      });

      if (result.queued) {
        router.replace('/(tabs)/contacts');
        return;
      }

      const response = result.response;
      if (response.ok) {
        const responseBody = (await response.json()) as CreateContactResponse;
        const newContactId = responseBody.data.id;
        if (captureId && token) {
          await matchCaptureToContact(captureId, newContactId, token);
        }
        router.replace({ pathname: '/contact/[id]', params: { id: newContactId } });
      } else {
        const parsedBody = (await response.json()) as ErrorResponse;
        setApiError(parsedBody?.error?.message ?? 'Failed to create contact');
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
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
            <Text style={styles.submitButtonText}>Create Contact</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  scrollView: { flex: 1 },
  content: { padding: 16 },
  errorBanner: {
    backgroundColor: '#FFEBEE',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  errorBannerText: { color: '#D93025' },
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
