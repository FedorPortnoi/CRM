import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  ListRenderItemInfo,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Check, MessageCircle, PhoneCall, Send } from 'lucide-react-native';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';
import { sendOrQueueMutation } from '../../../utils/offlineMutation';

type MessageDirection = 'inbound' | 'outbound';
type MessageChannel = 'sms' | 'in_app' | 'email';
type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
type ComposerMode = 'note' | 'call';

interface Contact {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
}

interface Message {
  id: string;
  contact_id: string;
  user_id: string | null;
  direction: MessageDirection;
  channel: MessageChannel;
  body: string;
  status: MessageStatus;
  error_message: string | null;
  read_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

interface ApiResponse<TData> {
  data: TData;
  meta?: Record<string, unknown>;
}

interface ErrorResponse {
  error?: { code?: string; message?: string };
}

interface LogCallRequest {
  contact_id: string;
  direction: MessageDirection;
  duration_seconds?: number;
  notes?: string;
  occurred_at?: string;
}

function fullName(contact: Contact): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ');
}

function timestampValue(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => timestampValue(a.created_at) - timestampValue(b.created_at));
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatChannel(channel: MessageChannel): string {
  if (channel === 'in_app') return 'In-app';
  return channel.toUpperCase();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (remaining === 0) return `${minutes}m`;
  return `${minutes}m ${remaining}s`;
}

function messageBodyParts(body: string): { bodyText: string; duration: string | null; isCall: boolean } {
  const match = body.match(/^\[(\d+)s\]\s*(.*)$/);
  if (match) {
    const durationSeconds = Number(match[1]);
    const text = match[2]?.trim() || 'Call logged';
    return {
      bodyText: text,
      duration: Number.isFinite(durationSeconds) ? formatDuration(durationSeconds) : null,
      isCall: true,
    };
  }

  const lowerBody = body.toLowerCase();
  return {
    bodyText: body,
    duration: null,
    isCall: lowerBody.startsWith('call logged') || lowerBody.startsWith('call note'),
  };
}

function statusText(message: Message): string {
  if (message.direction === 'inbound') {
    return message.read_at !== null || message.status === 'read' ? 'Read' : 'Unread';
  }
  if (message.status === 'failed') return 'Failed';
  if (message.status === 'pending') return 'Pending';
  if (message.status === 'delivered') return 'Delivered';
  if (message.status === 'read') return 'Read';
  return 'Sent';
}

function readErrorMessage(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((body: ErrorResponse) => body.error?.message ?? fallback)
    .catch(() => fallback);
}

function isMessage(value: Message | null): value is Message {
  return value !== null;
}

function submitErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function ContactMessagesScreen(): JSX.Element {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [contact, setContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [mode, setMode] = useState<ComposerMode>('note');
  const [noteBody, setNoteBody] = useState<string>('');
  const [callNotes, setCallNotes] = useState<string>('');
  const [callDirection, setCallDirection] = useState<MessageDirection>('outbound');
  const [durationMinutes, setDurationMinutes] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const contactTitle = useMemo<string>(() => {
    if (contact === null) return 'Conversation';
    return fullName(contact) || 'Conversation';
  }, [contact]);

  const markInboundRead = useCallback(
    async (loadedMessages: Message[]): Promise<void> => {
      if (!token) return;

      const unreadInbound = loadedMessages.filter(
        (message) =>
          message.direction === 'inbound' &&
          message.read_at === null &&
          message.status !== 'read',
      );
      if (unreadInbound.length === 0) return;

      const updatedMessages = await Promise.all(
        unreadInbound.map(async (message): Promise<Message | null> => {
          try {
            const response = await fetch(`${API_URL}/messages/${message.id}/read`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!response.ok) return null;
            const body = (await response.json()) as ApiResponse<Message>;
            return body.data;
          } catch {
            return null;
          }
        }),
      );

      const updateMap = new Map(
        updatedMessages.filter(isMessage).map((message) => [message.id, message]),
      );
      if (updateMap.size === 0) return;

      setMessages((current) =>
        current.map((message) => updateMap.get(message.id) ?? message),
      );
    },
    [token],
  );

  const loadConversation = useCallback(
    async (refreshing: boolean): Promise<void> => {
      if (!token) {
        setFetchError('You need to sign in again.');
        setIsLoading(false);
        setIsRefreshing(false);
        return;
      }

      if (refreshing) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setFetchError(null);

      try {
        const [contactResponse, messagesResponse] = await Promise.all([
          fetch(`${API_URL}/contacts/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(`${API_URL}/messages/conversation/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);

        if (!contactResponse.ok) {
          throw new Error(await readErrorMessage(contactResponse, 'Failed to load contact'));
        }
        if (!messagesResponse.ok) {
          throw new Error(await readErrorMessage(messagesResponse, 'Failed to load conversation'));
        }

        const contactBody = (await contactResponse.json()) as ApiResponse<Contact>;
        const messagesBody = (await messagesResponse.json()) as ApiResponse<Message[]>;
        const sortedMessages = sortMessages(messagesBody.data);

        setContact(contactBody.data);
        setMessages(sortedMessages);
        void markInboundRead(sortedMessages);
      } catch (error: unknown) {
        setFetchError(submitErrorMessage(error, 'Failed to load conversation'));
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [id, markInboundRead, token],
  );

  useEffect(() => {
    void loadConversation(false);
  }, [loadConversation]);

  const handleRefresh = useCallback((): void => {
    void loadConversation(true);
  }, [loadConversation]);

  const appendMessage = useCallback((message: Message): void => {
    setMessages((current) => sortMessages([...current, message]));
  }, []);

  const handleSendNote = async (): Promise<void> => {
    if (!token) return;
    const trimmedBody = noteBody.trim();
    if (trimmedBody === '') {
      setSubmitError('Enter a note before sending.');
      return;
    }

    setSubmitError(null);
    setIsSubmitting(true);

    try {
      const result = await sendOrQueueMutation({
        url: `${API_URL}/messages/in-app`,
        method: 'POST',
        token,
        body: { contact_id: id, body: trimmedBody },
      });

      if (result.queued) {
        setNoteBody('');
        return;
      }

      const response = result.response;

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, 'Failed to send note'));
      }

      const body = (await response.json()) as ApiResponse<Message>;
      appendMessage(body.data);
      setNoteBody('');
    } catch (error: unknown) {
      setSubmitError(submitErrorMessage(error, 'Failed to send note'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogCall = async (): Promise<void> => {
    if (!token) return;

    const trimmedDuration = durationMinutes.trim();
    const parsedMinutes = trimmedDuration === '' ? undefined : Number(trimmedDuration);
    if (
      parsedMinutes !== undefined &&
      (!Number.isFinite(parsedMinutes) || parsedMinutes < 0)
    ) {
      setSubmitError('Enter a valid call duration.');
      return;
    }

    const trimmedNotes = callNotes.trim();
    const payload: LogCallRequest = {
      contact_id: id,
      direction: callDirection,
      notes: trimmedNotes === '' ? 'Call logged' : `Call logged - ${trimmedNotes}`,
      occurred_at: new Date().toISOString(),
    };

    if (parsedMinutes !== undefined) {
      payload.duration_seconds = Math.round(parsedMinutes * 60);
    }

    setSubmitError(null);
    setIsSubmitting(true);

    try {
      const result = await sendOrQueueMutation({
        url: `${API_URL}/messages/call`,
        method: 'POST',
        token,
        body: payload,
      });

      if (result.queued) {
        setCallNotes('');
        setDurationMinutes('');
        return;
      }

      const response = result.response;

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, 'Failed to log call'));
      }

      const body = (await response.json()) as ApiResponse<Message>;
      appendMessage(body.data);
      setCallNotes('');
      setDurationMinutes('');
    } catch (error: unknown) {
      setSubmitError(submitErrorMessage(error, 'Failed to log call'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderMessage = useCallback(
    ({ item }: ListRenderItemInfo<Message>): JSX.Element => {
      const isOutbound = item.direction === 'outbound';
      const bodyParts = messageBodyParts(item.body);
      const bubbleTextStyle = isOutbound ? styles.outboundText : styles.inboundText;
      const mutedTextStyle = isOutbound ? styles.outboundMutedText : styles.inboundMutedText;

      return (
        <View style={[styles.messageRow, isOutbound ? styles.outboundRow : styles.inboundRow]}>
          <View style={[styles.messageBubble, isOutbound ? styles.outboundBubble : styles.inboundBubble]}>
            <View style={styles.messageMetaRow}>
              <Text style={[styles.messageChannel, mutedTextStyle]}>
                {bodyParts.isCall ? 'Call' : formatChannel(item.channel)}
              </Text>
              <Text style={[styles.messageTime, mutedTextStyle]}>
                {formatTimestamp(item.created_at)}
              </Text>
            </View>
            {bodyParts.duration !== null ? (
              <Text style={[styles.durationText, mutedTextStyle]}>{bodyParts.duration}</Text>
            ) : null}
            <Text style={[styles.messageText, bubbleTextStyle]}>{bodyParts.bodyText}</Text>
            <View style={styles.statusRow}>
              {item.status === 'read' ? <Check size={12} color={isOutbound ? '#D8E8FF' : '#6b7280'} /> : null}
              <Text style={[styles.statusText, mutedTextStyle]}>{statusText(item)}</Text>
            </View>
          </View>
        </View>
      );
    },
    [],
  );

  const noteDisabled = isSubmitting || noteBody.trim() === '';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={88}
    >
      <Stack.Screen options={{ title: contactTitle, headerBackTitle: 'Contact' }} />

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#10b981" />
        </View>
      ) : fetchError !== null ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{fetchError}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => { void loadConversation(false); }}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <FlatList
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
            contentContainerStyle={messages.length === 0 ? styles.emptyListContent : styles.listContent}
            ListHeaderComponent={
              contact !== null ? (
                <View style={styles.threadHeader}>
                  <Text style={styles.threadName}>{fullName(contact)}</Text>
                  {contact.company !== null ? (
                    <Text style={styles.threadDetail}>{contact.company}</Text>
                  ) : null}
                  {contact.phone !== null || contact.mobile !== null || contact.email !== null ? (
                    <Text style={styles.threadDetail}>
                      {[contact.phone, contact.mobile, contact.email].filter(Boolean).join('  ')}
                    </Text>
                  ) : null}
                </View>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <MessageCircle size={34} color="#9ca3af" />
                <Text style={styles.emptyTitle}>No conversation yet</Text>
                <Text style={styles.emptyText}>Start with a note or log the latest call.</Text>
              </View>
            }
          />

          <View style={styles.composer}>
            {submitError !== null ? (
              <View style={styles.submitErrorBanner}>
                <Text style={styles.submitErrorText}>{submitError}</Text>
              </View>
            ) : null}

            <View style={styles.modeRow}>
              <TouchableOpacity
                style={[styles.modeButton, mode === 'note' ? styles.modeButtonActive : null]}
                onPress={() => setMode('note')}
                disabled={isSubmitting}
                activeOpacity={0.7}
              >
                <MessageCircle size={16} color={mode === 'note' ? '#FFFFFF' : '#10b981'} />
                <Text style={[styles.modeButtonText, mode === 'note' ? styles.modeButtonTextActive : null]}>
                  Note
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeButton, mode === 'call' ? styles.modeButtonActive : null]}
                onPress={() => setMode('call')}
                disabled={isSubmitting}
                activeOpacity={0.7}
              >
                <PhoneCall size={16} color={mode === 'call' ? '#FFFFFF' : '#10b981'} />
                <Text style={[styles.modeButtonText, mode === 'call' ? styles.modeButtonTextActive : null]}>
                  Call
                </Text>
              </TouchableOpacity>
            </View>

            {mode === 'note' ? (
              <View style={styles.noteComposerRow}>
                <TextInput
                  style={styles.noteInput}
                  value={noteBody}
                  onChangeText={setNoteBody}
                  placeholder={t('contacts.writeInAppNote')}
                  placeholderTextColor="#9ca3af"
                  multiline
                  textAlignVertical="top"
                  editable={!isSubmitting}
                />
                <TouchableOpacity
                  style={[styles.sendButton, noteDisabled ? styles.buttonDisabled : null]}
                  onPress={() => { void handleSendNote(); }}
                  disabled={noteDisabled}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Send note"
                >
                  {isSubmitting ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Send size={18} color="#FFFFFF" />
                  )}
                </TouchableOpacity>
              </View>
            ) : (
              <View>
                <View style={styles.directionRow}>
                  <TouchableOpacity
                    style={[
                      styles.directionButton,
                      callDirection === 'outbound' ? styles.directionButtonActive : null,
                    ]}
                    onPress={() => setCallDirection('outbound')}
                    disabled={isSubmitting}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.directionButtonText,
                        callDirection === 'outbound' ? styles.directionButtonTextActive : null,
                      ]}
                    >
                      Outbound
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.directionButton,
                      callDirection === 'inbound' ? styles.directionButtonActive : null,
                    ]}
                    onPress={() => setCallDirection('inbound')}
                    disabled={isSubmitting}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.directionButtonText,
                        callDirection === 'inbound' ? styles.directionButtonTextActive : null,
                      ]}
                    >
                      Inbound
                    </Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.callFieldsRow}>
                  <TextInput
                    style={[styles.callInput, styles.durationInput]}
                    value={durationMinutes}
                    onChangeText={setDurationMinutes}
                    placeholder="Min"
                    placeholderTextColor="#9ca3af"
                    keyboardType="decimal-pad"
                    editable={!isSubmitting}
                  />
                  <TextInput
                    style={[styles.callInput, styles.callNotesInput]}
                    value={callNotes}
                    onChangeText={setCallNotes}
                    placeholder={t('contacts.callNotes')}
                    placeholderTextColor="#9ca3af"
                    multiline
                    textAlignVertical="top"
                    editable={!isSubmitting}
                  />
                </View>
                <TouchableOpacity
                  style={[styles.logCallButton, isSubmitting ? styles.buttonDisabled : null]}
                  onPress={() => { void handleLogCall(); }}
                  disabled={isSubmitting}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Log call"
                >
                  {isSubmitting ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <PhoneCall size={17} color="#FFFFFF" />
                      <Text style={styles.logCallButtonText}>Log Call</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0fdf8' },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errorText: { color: '#ef4444', fontSize: 14, textAlign: 'center', marginBottom: 16 },
  retryButton: {
    backgroundColor: '#10b981',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  listContent: { padding: 12, paddingBottom: 16 },
  emptyListContent: { flexGrow: 1, padding: 12 },
  threadHeader: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  threadName: { color: '#111827', fontSize: 17, fontWeight: '700', marginBottom: 4 },
  threadDetail: { color: '#6b7280', fontSize: 12, lineHeight: 18 },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyTitle: { color: '#111827', fontSize: 17, fontWeight: '700', marginTop: 12 },
  emptyText: { color: '#6b7280', fontSize: 14, marginTop: 4, textAlign: 'center' },
  messageRow: { flexDirection: 'row', marginBottom: 10 },
  outboundRow: { justifyContent: 'flex-end' },
  inboundRow: { justifyContent: 'flex-start' },
  messageBubble: {
    maxWidth: '84%',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  outboundBubble: { backgroundColor: '#10b981' },
  inboundBubble: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E4E4E4',
  },
  messageMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
  },
  messageChannel: { fontSize: 11, fontWeight: '700' },
  messageTime: { fontSize: 11 },
  messageText: { fontSize: 14, lineHeight: 20 },
  outboundText: { color: '#FFFFFF' },
  inboundText: { color: '#111827' },
  outboundMutedText: { color: '#D8E8FF' },
  inboundMutedText: { color: '#6b7280' },
  durationText: { fontSize: 12, fontWeight: '600', marginBottom: 3 },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 5,
  },
  statusText: { fontSize: 11 },
  composer: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 14,
  },
  submitErrorBanner: {
    backgroundColor: '#fef2f2',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  submitErrorText: { color: '#ef4444', fontSize: 13 },
  modeRow: {
    flexDirection: 'row',
    backgroundColor: '#ecfdf5',
    borderRadius: 12,
    padding: 3,
    marginBottom: 10,
  },
  modeButton: {
    flex: 1,
    minHeight: 36,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  modeButtonActive: { backgroundColor: '#10b981' },
  modeButtonText: { color: '#10b981', fontSize: 13, fontWeight: '700' },
  modeButtonTextActive: { color: '#FFFFFF' },
  noteComposerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  noteInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 104,
    backgroundColor: '#F7F7F7',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#111827',
    fontSize: 14,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.55 },
  directionRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  directionButton: {
    flex: 1,
    minHeight: 36,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D6E4FA',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  directionButtonActive: { backgroundColor: '#ecfdf5', borderColor: '#10b981' },
  directionButtonText: { color: '#6b7280', fontSize: 13, fontWeight: '700' },
  directionButtonTextActive: { color: '#10b981' },
  callFieldsRow: { flexDirection: 'row', gap: 8 },
  callInput: {
    backgroundColor: '#F7F7F7',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    color: '#111827',
    fontSize: 14,
  },
  durationInput: { width: 72 },
  callNotesInput: { flex: 1, minHeight: 44, maxHeight: 92 },
  logCallButton: {
    marginTop: 10,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: '#188038',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  logCallButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
});
