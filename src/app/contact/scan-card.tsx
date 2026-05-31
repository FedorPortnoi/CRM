import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Camera, ScanText } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type CameraPermissionState = 'unknown' | 'granted' | 'denied';

function mapCameraPermission(
  permission: ImagePicker.PermissionResponse,
): CameraPermissionState {
  if (permission.granted) {
    return 'granted';
  }

  return permission.status === 'denied' ? 'denied' : 'unknown';
}

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
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [manualText, setManualText] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraPermission, setCameraPermission] =
    useState<CameraPermissionState>('unknown');
  const [isRequestingCamera, setIsRequestingCamera] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const loadCameraPermission = async (): Promise<void> => {
      try {
        const permission = await ImagePicker.getCameraPermissionsAsync();

        if (isMounted) {
          setCameraPermission(mapCameraPermission(permission));
        }
      } catch {
        if (isMounted) {
          setCameraPermission('unknown');
        }
      }
    };

    void loadCameraPermission();

    return (): void => {
      isMounted = false;
    };
  }, []);

  const setSelectedImage = (asset: ImagePicker.ImagePickerAsset): void => {
    setImageUri(asset.uri);
    setImageBase64(asset.base64 ?? null);
    setError(null);
  };

  const takePhoto = async (): Promise<void> => {
    try {
      setIsRequestingCamera(true);
      const permission = await ImagePicker.requestCameraPermissionsAsync();

      if (!permission.granted) {
        setCameraPermission('denied');
        setError(
          'Camera access is off. You can enable it in settings, choose an image, or paste the card text for manual review.',
        );
        return;
      }

      setCameraPermission('granted');
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        base64: true,
        quality: 0.8,
      });

      if (result.canceled || !result.assets[0]) return;
      setSelectedImage(result.assets[0]);
    } catch {
      setError(
        'Could not open the camera. Choose an image or paste the card text for manual review.',
      );
    } finally {
      setIsRequestingCamera(false);
    }
  };

  const pickImage = async (): Promise<void> => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        base64: true,
        quality: 0.8,
      });

      if (result.canceled || !result.assets[0]) return;
      setSelectedImage(result.assets[0]);
    } catch {
      setError(
        'Could not open the image library. Take a photo or paste the card text for manual review.',
      );
    }
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

      const body = (await response.json()) as ScanResponse & {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? `Scan failed with status ${response.status}`,
        );
      }

      const name = [
        body.data.extracted.first_name,
        body.data.extracted.last_name,
      ]
        .filter(Boolean)
        .join(' ');
      Alert.alert('Contact created', name || 'Business card contact created', [
        {
          text: 'Open',
          onPress: () => {
            if (body.data.contact?.id) {
              router.replace({
                pathname: '/contact/[id]',
                params: { id: body.data.contact.id },
              });
            } else {
              router.replace('/(tabs)/contacts');
            }
          },
        },
      ]);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Scan failed';
      setError(
        `${message}. Retake the photo, choose a clearer image, or paste the card text for manual review.`,
      );
    } finally {
      setIsScanning(false);
    }
  };

  const canScan = Boolean(imageBase64 || manualText.trim());
  const permissionText =
    cameraPermission === 'denied'
      ? 'Camera permission denied. Use Settings, choose from library, or paste text.'
      : 'Take a clear photo of the card, or use the fallback options below.';

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Business card</Text>
        <Text style={styles.helperText}>{permissionText}</Text>
        <View style={styles.capturePanel}>
          {imageUri ? (
            <>
              <Image source={{ uri: imageUri }} style={styles.image} />
              <View style={styles.captureActions}>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => {
                    void takePhoto();
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryButtonText}>Retake photo</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => {
                    void pickImage();
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryButtonText}>Change image</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <TouchableOpacity
                style={[
                  styles.cameraButton,
                  isRequestingCamera && styles.buttonDisabled,
                ]}
                disabled={isRequestingCamera}
                onPress={() => {
                  void takePhoto();
                }}
                accessibilityRole="button"
              >
                {isRequestingCamera ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Camera size={24} color="#FFFFFF" />
                )}
                <Text style={styles.cameraButtonText}>Take photo</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.libraryButton}
                onPress={() => {
                  void pickImage();
                }}
                accessibilityRole="button"
              >
                <Text style={styles.libraryButtonText}>
                  Choose from library
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
        {cameraPermission === 'denied' ? (
          <TouchableOpacity
            style={styles.settingsButton}
            onPress={() => {
              void Linking.openSettings();
            }}
            accessibilityRole="button"
          >
            <Text style={styles.settingsButtonText}>Open camera settings</Text>
          </TouchableOpacity>
        ) : null}
        <Text style={styles.sectionLabel}>Manual review fallback</Text>
        <TextInput
          value={manualText}
          onChangeText={setManualText}
          placeholder={`${t('contacts.pasteCardText')} for manual review`}
          style={styles.input}
          multiline
          textAlignVertical="top"
        />
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.error}>{error}</Text>
            <View style={styles.errorActions}>
              <TouchableOpacity
                style={styles.errorAction}
                onPress={() => {
                  void takePhoto();
                }}
                accessibilityRole="button"
              >
                <Text style={styles.errorActionText}>Retake</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.errorAction}
                onPress={() => {
                  void pickImage();
                }}
                accessibilityRole="button"
              >
                <Text style={styles.errorActionText}>Choose image</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        <TouchableOpacity
          style={[styles.button, isScanning && styles.buttonDisabled]}
          disabled={isScanning || !canScan}
          onPress={() => {
            void scan();
          }}
          accessibilityRole="button"
        >
          {isScanning ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <ScanText size={20} color="#FFFFFF" />
          )}
          <Text style={styles.buttonText}>Scan and create</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FAF6F3' },
  container: { padding: 16, paddingBottom: 28 },
  title: { fontSize: 26, fontWeight: '700', color: '#383432', marginBottom: 8 },
  helperText: { color: '#4B5563', lineHeight: 20, marginBottom: 12 },
  capturePanel: {
    minHeight: 190,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 12,
  },
  image: { width: '100%', height: 190, borderRadius: 8 },
  captureActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  cameraButton: {
    height: 52,
    minWidth: 180,
    borderRadius: 12,
    backgroundColor: '#C4704F',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  cameraButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  libraryButton: { marginTop: 12, paddingVertical: 10, paddingHorizontal: 12 },
  libraryButtonText: { color: '#047857', fontWeight: '700' },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  secondaryButtonText: { color: '#047857', fontWeight: '700' },
  settingsButton: {
    alignSelf: 'flex-start',
    paddingVertical: 10,
    marginTop: 4,
  },
  settingsButtonText: { color: '#047857', fontWeight: '700' },
  sectionLabel: {
    marginTop: 16,
    marginBottom: 8,
    color: '#383432',
    fontWeight: '700',
  },
  input: {
    minHeight: 160,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E8DDD6',
    backgroundColor: '#FFFFFF',
    padding: 12,
    color: '#383432',
  },
  errorBox: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
    padding: 12,
  },
  error: { color: '#991B1B', lineHeight: 20 },
  errorActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  errorAction: {
    minHeight: 38,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  errorActionText: { color: '#991B1B', fontWeight: '700' },
  button: {
    height: 52,
    borderRadius: 12,
    backgroundColor: '#C4704F',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
});
