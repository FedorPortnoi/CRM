import { useEffect, useMemo, useState } from 'react';
import {
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
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Button } from '../../components/ui';

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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
        setError(t('contacts.scanCameraAccessOff'));
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
      setError(t('contacts.scanCouldNotOpenCamera'));
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
      setError(t('contacts.scanCouldNotOpenLibrary'));
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
      Alert.alert(t('contacts.scanContactCreated'), name || t('contacts.scanBusinessCardCreated'), [
        {
          text: t('contacts.scanOpen'),
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
      setError(t('contacts.scanFailed'));
    } finally {
      setIsScanning(false);
    }
  };

  const canScan = Boolean(imageBase64 || manualText.trim());
  const permissionText =
    cameraPermission === 'denied'
      ? t('contacts.scanPermissionDenied')
      : t('contacts.scanPermissionHelp');

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{t('contacts.scanTitle')}</Text>
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
                  activeOpacity={0.7}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryButtonText}>{t('contacts.scanRetakePhoto')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => {
                    void pickImage();
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryButtonText}>{t('contacts.scanChangeImage')}</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Button
                title={t('contacts.scanTakePhoto')}
                onPress={() => {
                  void takePhoto();
                }}
                loading={isRequestingCamera}
                icon={<Camera size={24} color={colors.onAccent} />}
                style={styles.cameraButton}
              />
              <TouchableOpacity
                style={styles.libraryButton}
                onPress={() => {
                  void pickImage();
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <Text style={styles.libraryButtonText}>{t('contacts.scanChooseFromLibrary')}</Text>
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
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.settingsButtonText}>{t('contacts.scanOpenSettings')}</Text>
          </TouchableOpacity>
        ) : null}
        <Text style={styles.sectionLabel}>{t('contacts.scanManualFallback')}</Text>
        <TextInput
          value={manualText}
          onChangeText={setManualText}
          placeholder={t('contacts.pasteCardText')}
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
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <Text style={styles.errorActionText}>{t('contacts.scanRetake')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.errorAction}
                onPress={() => {
                  void pickImage();
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <Text style={styles.errorActionText}>{t('contacts.scanChooseImage')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        <Button
          title={t('contacts.scanAndCreate')}
          onPress={() => {
            void scan();
          }}
          disabled={!canScan}
          loading={isScanning}
          icon={<ScanText size={20} color={colors.onAccent} />}
          block
          style={styles.button}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  container: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: { ...type.display, color: c.text1, marginBottom: spacing.sm },
  helperText: { ...type.body, color: c.textMuted, marginBottom: spacing.md },
  capturePanel: {
    minHeight: 190,
    borderRadius: radius.lg,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: spacing.md,
  },
  image: { width: '100%', height: 190, borderRadius: radius.md },
  captureActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  cameraButton: { minWidth: 180 },
  libraryButton: { marginTop: spacing.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  libraryButtonText: { ...type.label, color: c.success },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.success,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  secondaryButtonText: { ...type.label, color: c.success },
  settingsButton: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  settingsButtonText: { ...type.label, color: c.success },
  sectionLabel: {
    ...type.label,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    color: c.text1,
  },
  input: {
    minHeight: 160,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    backgroundColor: c.surface,
    padding: spacing.md,
    ...type.body,
    color: c.text1,
  },
  errorBox: {
    marginTop: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.danger,
    backgroundColor: c.dangerSoft,
    padding: spacing.md,
  },
  error: { ...type.body, color: c.danger },
  errorActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  errorAction: {
    minHeight: 38,
    borderRadius: radius.md,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  errorActionText: { ...type.label, color: c.danger },
  button: {
    marginTop: spacing.lg,
  },
});
