import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Linking,
  Platform,
  ActionSheetIOS,
  StyleSheet,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Paperclip, Trash2, FileText, Image } from 'lucide-react-native';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';

type EntityType = 'contact' | 'deal' | 'task' | 'calendar_event';

interface Attachment {
  id: string;
  filename: string;
  file_url: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
}

interface Props {
  entityType: EntityType;
  entityId: string;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(mimeType: string | null): boolean {
  return mimeType?.startsWith('image/') ?? false;
}

export default function AttachmentsSection({ entityType, entityId }: Props) {
  const { token } = useUserStore();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);

  const fetchAttachments = useCallback(async () => {
    if (!token || !entityId) return;
    try {
      const res = await fetch(
        `${API_URL}/attachments?entity_type=${entityType}&entity_id=${entityId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return;
      const body = (await res.json()) as { data: Attachment[] };
      setAttachments(body.data);
    } catch { /* silent */ }
  }, [token, entityType, entityId]);

  useEffect(() => { void fetchAttachments(); }, [fetchAttachments]);

  const uploadFile = async (uri: string, filename: string, mimeType: string, size: number) => {
    setUploading(true);
    try {
      // 1. Get presigned URL
      const urlRes = await fetch(`${API_URL}/attachments/upload-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, filename, mime_type: mimeType, size }),
      });
      if (!urlRes.ok) {
        const err = (await urlRes.json()) as { error?: { message: string } };
        Alert.alert('Upload failed', err.error?.message ?? 'Could not get upload URL');
        return;
      }
      const { data } = (await urlRes.json()) as {
        data: { upload_url: string; fields: Record<string, string>; file_url: string };
      };

      // 2. Upload to S3 via presigned POST
      const formData = new FormData();
      Object.entries(data.fields).forEach(([k, v]) => formData.append(k, v));
      formData.append('file', { uri, name: filename, type: mimeType } as unknown as Blob);
      const s3Res = await fetch(data.upload_url, { method: 'POST', body: formData });
      if (!s3Res.ok && s3Res.status !== 204) {
        Alert.alert('Upload failed', 'Could not upload to storage');
        return;
      }

      // 3. Save metadata
      const metaRes = await fetch(`${API_URL}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId,
          filename,
          file_url: data.file_url,
          mime_type: mimeType,
          size,
        }),
      });
      if (metaRes.ok) {
        void fetchAttachments();
      } else {
        Alert.alert('Error', 'File uploaded but metadata save failed');
      }
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const pickFromGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission required', 'Allow photo access to attach images'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 0.85,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const filename = asset.fileName ?? `photo_${Date.now()}.jpg`;
    const mimeType = asset.mimeType ?? 'image/jpeg';
    const size = asset.fileSize ?? 0;
    await uploadFile(asset.uri, filename, mimeType, size);
  };

  const pickFromCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission required', 'Allow camera access to take photos'); return; }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.85, allowsEditing: false });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const filename = asset.fileName ?? `photo_${Date.now()}.jpg`;
    const mimeType = asset.mimeType ?? 'image/jpeg';
    const size = asset.fileSize ?? 0;
    await uploadFile(asset.uri, filename, mimeType, size);
  };

  const pickDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const mimeType = asset.mimeType ?? 'application/octet-stream';
    const size = asset.size ?? 0;
    await uploadFile(asset.uri, asset.name, mimeType, size);
  };

  const showPicker = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Photo from Gallery', 'Take Photo', 'Document / File'], cancelButtonIndex: 0 },
        (idx) => {
          if (idx === 1) void pickFromGallery();
          else if (idx === 2) void pickFromCamera();
          else if (idx === 3) void pickDocument();
        },
      );
    } else {
      Alert.alert('Add Attachment', undefined, [
        { text: 'Photo from Gallery', onPress: () => void pickFromGallery() },
        { text: 'Take Photo', onPress: () => void pickFromCamera() },
        { text: 'Document / File', onPress: () => void pickDocument() },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const deleteAttachment = (att: Attachment) => {
    Alert.alert('Delete attachment', `Remove "${att.filename}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await fetch(`${API_URL}/attachments/${att.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
            });
            setAttachments(prev => prev.filter(a => a.id !== att.id));
          } catch { Alert.alert('Error', 'Could not delete attachment'); }
        },
      },
    ]);
  };

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.title}>Attachments</Text>
        <TouchableOpacity
          style={styles.addButton}
          onPress={showPicker}
          disabled={uploading}
          activeOpacity={0.7}
        >
          {uploading
            ? <ActivityIndicator size="small" color="#C45A10" />
            : <Text style={styles.addButtonText}>+ Add</Text>}
        </TouchableOpacity>
      </View>

      {attachments.length === 0 && !uploading && (
        <Text style={styles.empty}>No attachments</Text>
      )}

      {attachments.map((att) => (
        <TouchableOpacity
          key={att.id}
          style={styles.row}
          onPress={() => void Linking.openURL(att.file_url)}
          onLongPress={() => deleteAttachment(att)}
          activeOpacity={0.7}
        >
          <View style={styles.fileIcon}>
            {isImage(att.mime_type)
              ? <Image size={16} color="#C45A10" />
              : <FileText size={16} color="#C45A10" />}
          </View>
          <View style={styles.fileInfo}>
            <Text style={styles.filename} numberOfLines={1}>{att.filename}</Text>
            {att.size !== null && <Text style={styles.fileSize}>{formatSize(att.size)}</Text>}
          </View>
          <TouchableOpacity
            onPress={() => deleteAttachment(att)}
            style={styles.deleteBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Trash2 size={16} color="#CFADA3" />
          </TouchableOpacity>
        </TouchableOpacity>
      ))}

      {uploading && (
        <View style={styles.uploadingRow}>
          <Paperclip size={16} color="#CFADA3" />
          <Text style={styles.uploadingText}>Uploading…</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: '#383432',
  },
  addButton: {
    minWidth: 44,
    minHeight: 32,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  addButtonText: {
    color: '#C45A10',
    fontSize: 14,
    fontWeight: '500',
  },
  empty: {
    fontSize: 14,
    color: '#CFADA3',
    textAlign: 'center',
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#FAF6F3',
    gap: 10,
  },
  fileIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#FEF0E8',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileInfo: {
    flex: 1,
  },
  filename: {
    fontSize: 14,
    color: '#383432',
    fontWeight: '500',
  },
  fileSize: {
    fontSize: 12,
    color: '#CFADA3',
    marginTop: 2,
  },
  deleteBtn: {
    padding: 4,
  },
  uploadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#FAF6F3',
  },
  uploadingText: {
    fontSize: 14,
    color: '#CFADA3',
  },
});
