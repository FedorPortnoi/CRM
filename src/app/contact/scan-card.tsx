import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { Camera, ScanText } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type ScanResponse = {
  data: {
    extracted: {
      first_name: string;
      last_name?: string;
      company?: string;
      email?: string;
      phone?: string;
    };
    contact: { id: string } | null;
  };
};

export default function ScanCardScreen(): JSX.Element {
  const token = useUserStore((s) => s.token);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [manualText, setManualText] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickImage = async (): Promise<void> => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      base64: true,
      quality: 0.8,
    });

    if (result.canceled || !result.assets[0]) return;
    setImageUri(result.assets[0].uri);
    setImageBase64(result.assets[0].base64 ?? null);
    setError(null);
  };

  const scan = async (): Promise<void> => {
    if (!token) return;
    try {
      setIsScanning(true);
      setError(null);
      const response = await fetch(`${API_URL}/contacts/business-card/scan`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image_base64: imageBase64 ?? undefined,
          text: manualText.trim() || undefined,
          create_contact: true,
        }),
      });

      const body = await response.json() as ScanResponse & { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? `Scan failed with status ${response.status}`);
      }

      const name = [body.data.extracted.first_name, body.data.extracted.last_name].filter(Boolean).join(' ');
      Alert.alert('Contact created', name || 'Business card contact created', [
        {
          text: 'Open',
          onPress: () => {
            if (body.data.contact?.id) {
              router.replace({ pathname: '/contact/[id]', params: { id: body.data.contact.id } });
            } else {
              router.replace('/(tabs)/contacts');
            }
          },
        },
      ]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title}>Business card</Text>
        <TouchableOpacity style={styles.imageButton} onPress={() => { void pickImage(); }} accessibilityRole="button">
          {imageUri ? <Image source={{ uri: imageUri }} style={styles.image} /> : <Camera size={28} color="#1A73E8" />}
          <Text style={styles.imageText}>{imageUri ? 'Change image' : 'Choose image'}</Text>
        </TouchableOpacity>
        <TextInput
          value={manualText}
          onChangeText={setManualText}
          placeholder="Paste card text"
          style={styles.input}
          multiline
          textAlignVertical="top"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.button, isScanning && styles.buttonDisabled]}
          disabled={isScanning || (!imageBase64 && !manualText.trim())}
          onPress={() => { void scan(); }}
          accessibilityRole="button"
        >
          {isScanning ? <ActivityIndicator color="#FFFFFF" /> : <ScanText size={20} color="#FFFFFF" />}
          <Text style={styles.buttonText}>Scan and create</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F7F8FA' },
  container: { flex: 1, padding: 16 },
  title: { fontSize: 26, fontWeight: '700', color: '#111827', marginBottom: 12 },
  imageButton: {
    minHeight: 160,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: { width: '100%', height: 180 },
  imageText: { marginTop: 8, color: '#1A73E8', fontWeight: '700' },
  input: {
    minHeight: 160,
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
    padding: 12,
    color: '#111827',
  },
  error: { color: '#C5221F', marginTop: 12 },
  button: {
    height: 52,
    borderRadius: 8,
    backgroundColor: '#1A73E8',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
});
