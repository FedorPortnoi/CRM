// AI assistant chat screen.
//
// Backend: GET  /api/v1/assistant/status
//          POST /api/v1/assistant/messages          { message, conversation_id? }
//          POST /api/v1/assistant/transcribe        multipart { file }
//          GET  /api/v1/assistant/conversations
//          GET  /api/v1/assistant/conversations/:id
// i18n:    assistant.*
// Data:    src/hooks/useAssistant.ts (react-query), src/utils/assistantTools.ts
//
// Three things drive the layout:
//
// 1. There is no streaming (the server answers with `stream: false`) and a turn
//    that walks a chain of CRM tool calls legitimately takes tens of seconds.
//    Silence reads as a hang, so the pending turn gets a spinner, a sentence
//    saying why it is slow, and a running seconds counter.
//
// 2. What the assistant DID is shown separately from what it SAYS — see
//    components/assistant/ToolActivity. Prose is not evidence that a contact
//    was created.
//
// 3. The service account may not hold ai.languageModels.user yet, so the whole
//    feature can be unavailable on a correctly deployed server. That case gets
//    a real explanation (what is missing, who fixes it, what still works), not
//    a spinner and not a raw SERVICE_NOT_CONFIGURED.
//
// A `viewer` is refused by the global role rule in backend/api/authenticate.ts
// (403 on any non-GET), so the composer is replaced with a note rather than
// letting them type into a guaranteed failure.
//
// Voice input (the mic in the composer) is record → transcribe → REVIEW: the
// transcript lands in the text box instead of being sent, because the
// assistant acts on CRM data and a mis-heard «удали» must die in the box, not
// in a tool call. The mic only appears when the server reports voice_input —
// the server keeps it off until the owner has accepted that recordings go to
// a foreign speech-recognition provider (see backend/services/transcription.ts).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, History, Mic, Plus, Send, ServerCog, Sparkles, X } from 'lucide-react-native';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useUserStore } from '../../store/userStore';
import { formatMarketDateTime, formatMarketTime } from '../../market/profile';
import {
  ASSISTANT_MAX_MESSAGE_CHARS,
  assistantErrorCode,
  buildTranscript,
  useAssistantConversation,
  useAssistantConversations,
  useAssistantStatus,
  useSendAssistantMessage,
  useTranscribeVoice,
  type AssistantBubble,
  type AssistantErrorCode,
} from '../../hooks/useAssistant';
import ToolActivity from '../../components/assistant/ToolActivity';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

/** Warn about the server-side cap only when the user is close to it. */
const CHARS_LEFT_WARNING = 300;

// Provider faults come back operator-facing and in English; every code gets a
// Russian sentence here. An unmapped code falls through to failedToSend rather
// than putting `AI_SOMETHING_NEW` on screen.
const ERROR_KEY_BY_CODE: Record<string, string> = {
  SERVICE_NOT_CONFIGURED: 'assistant.notConfigured',
  AI_UNAUTHORIZED: 'assistant.notConfigured',
  AI_RATE_LIMITED: 'assistant.rateLimited',
  AI_TIMEOUT: 'assistant.timeout',
  AI_UNAVAILABLE: 'assistant.unavailable',
  AI_BAD_RESPONSE: 'assistant.unavailable',
  AI_REQUEST_FAILED: 'assistant.unavailable',
  VALIDATION_ERROR: 'assistant.failedToSend',
  FORBIDDEN: 'assistant.readOnlyRole',
  NETWORK_ERROR: 'errors.networkError',
};

/** Codes that mean "the feature is not available", not "this attempt failed". */
function isNotConfiguredCode(code: AssistantErrorCode | null): boolean {
  return code === 'SERVICE_NOT_CONFIGURED' || code === 'AI_UNAUTHORIZED';
}

// ── Voice input ──────────────────────────────────────────────────────────────

/** Mono 64 kbps AAC in an m4a container — ~0.5 MB per minute of speech. The
 * HIGH_QUALITY preset is the base because LOW_QUALITY switches Android to
 * 3gp/AMR, which the transcription service does not accept. */
const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
};

/** Hard stop, mirrored nowhere server-side on purpose: the server caps bytes
 * (15 MiB), the client caps time, and both are generous for a spoken command. */
const MAX_VOICE_RECORDING_MS = 120_000;

/** Recordings shorter than this are treated as an accidental tap and dropped
 * without an upload or an error. */
const MIN_VOICE_RECORDING_MS = 500;

type VoiceState = 'idle' | 'recording' | 'transcribing';

function voiceErrorKey(code: AssistantErrorCode): string {
  switch (code) {
    case 'SERVICE_NOT_CONFIGURED':
    case 'AI_UNAUTHORIZED':
      return 'assistant.notConfigured';
    case 'AI_RATE_LIMITED':
      return 'assistant.rateLimited';
    case 'AI_TIMEOUT':
      return 'assistant.timeout';
    case 'NETWORK_ERROR':
      return 'errors.networkError';
    default:
      return 'assistant.voiceTranscribeFailed';
  }
}

function formatVoiceDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

export default function AssistantScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  // edgeToEdgeEnabled is on, so the app draws under the transparent system navigation
  // bar. Without padding the composer for that inset, the bar area shows the window
  // background instead of ours — a white strip under the input on gesture-nav devices.
  const insets = useSafeAreaInsets();
  const role = useUserStore((s) => s.user?.role);
  const canChat = role !== 'viewer';

  const listRef = useRef<FlatList<AssistantBubble>>(null);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [openedConversationId, setOpenedConversationId] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<AssistantBubble[]>([]);
  const [draft, setDraft] = useState<string>('');
  const [errorCode, setErrorCode] = useState<AssistantErrorCode | null>(null);
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  const statusQuery = useAssistantStatus();
  const conversationsQuery = useAssistantConversations(historyOpen);
  const conversationQuery = useAssistantConversation(openedConversationId);
  const sendMutation = useSendAssistantMessage();

  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceErrorText, setVoiceErrorText] = useState<string | null>(null);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder);
  const { mutate: transcribeVoice } = useTranscribeVoice();

  const isSending = sendMutation.isPending;

  // `configured` only reports that the env vars are set. A service account that
  // is missing the role answers `true` here and fails at send time — both land
  // on the same explanation.
  const notConfigured =
    statusQuery.data?.configured === false || isNotConfiguredCode(errorCode);

  // ── Reopening a conversation from history ──────────────────────────────────
  useEffect(() => {
    const detail = conversationQuery.data;
    if (!detail || detail.id !== openedConversationId) return;
    setConversationId(detail.id);
    setBubbles(buildTranscript(detail.messages));
  }, [conversationQuery.data, openedConversationId]);

  // ── "Thinking" clock: a silent minute is indistinguishable from a hang ─────
  useEffect(() => {
    if (!isSending) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.round((Date.now() - startedAt) / 1000));
    }, 1000);
    return (): void => clearInterval(timer);
  }, [isSending]);

  const submit = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || isSending) return;

      setErrorCode(null);
      const localKey = `local-${String(Date.now())}`;
      setBubbles((prev) => [
        ...prev,
        {
          key: localKey,
          role: 'user',
          content: trimmed,
          toolCalls: [],
          created_at: new Date().toISOString(),
          state: 'sending',
        },
      ]);

      sendMutation.mutate(
        {
          message: trimmed,
          ...(conversationId === null ? {} : { conversation_id: conversationId }),
        },
        {
          onSuccess: (data) => {
            setConversationId(data.conversation_id);
            setOpenedConversationId(null);
            setBubbles((prev) => [
              ...prev.map((bubble) =>
                bubble.key === localKey ? { ...bubble, state: undefined } : bubble,
              ),
              {
                key: data.message.id,
                role: 'assistant',
                content: data.message.content,
                toolCalls: data.tool_calls ?? [],
                created_at: data.message.created_at,
              },
            ]);
          },
          onError: (error) => {
            // A failed turn writes nothing server-side, so the text is kept on
            // the failed bubble and resending it cannot duplicate anything.
            setErrorCode(assistantErrorCode(error));
            setBubbles((prev) =>
              prev.map((bubble) =>
                bubble.key === localKey ? { ...bubble, state: 'failed' as const } : bubble,
              ),
            );
          },
        },
      );
    },
    [conversationId, isSending, sendMutation],
  );

  const handleSend = useCallback((): void => {
    // Clearing the box before knowing the turn will start would lose the text
    // on the one path submit() refuses (a turn already in flight).
    if (isSending || draft.trim().length === 0) return;
    const text = draft;
    setDraft('');
    submit(text);
  }, [draft, isSending, submit]);

  const handleRetry = useCallback((): void => {
    const failed = [...bubbles].reverse().find((bubble) => bubble.state === 'failed');
    if (!failed) return;
    setBubbles((prev) => prev.filter((bubble) => bubble.key !== failed.key));
    submit(failed.content);
  }, [bubbles, submit]);

  // ── Voice input: record → transcribe → review in the composer ─────────────
  const startRecording = useCallback(async (): Promise<void> => {
    setVoiceErrorText(null);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setVoiceErrorText(t('assistant.voiceMicDenied'));
        return;
      }
      // allowsRecording routes iOS audio through the record-capable session;
      // without it record() silently produces an empty file.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setVoiceState('recording');
    } catch {
      setVoiceState('idle');
      setVoiceErrorText(t('assistant.voiceRecordFailed'));
    }
  }, [recorder, t]);

  const cancelRecording = useCallback(async (): Promise<void> => {
    setVoiceState('idle');
    try {
      await recorder.stop();
    } catch {
      // Already stopped (auto-stop raced the tap) — nothing to clean up.
    }
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
  }, [recorder]);

  const finishRecording = useCallback(async (): Promise<void> => {
    const durationMs = recorderState.durationMillis;
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
    } catch {
      uri = null;
    }
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);

    // A sub-second tap is an accident, not a message — drop it silently.
    if (durationMs < MIN_VOICE_RECORDING_MS) {
      setVoiceState('idle');
      return;
    }
    if (uri === null) {
      setVoiceState('idle');
      setVoiceErrorText(t('assistant.voiceRecordFailed'));
      return;
    }

    setVoiceState('transcribing');
    transcribeVoice(
      { uri },
      {
        onSuccess: ({ text }) => {
          setVoiceState('idle');
          if (text.length === 0) {
            setVoiceErrorText(t('assistant.voiceEmpty'));
            return;
          }
          // Appended, not sent: the user reviews (and can fix) the transcript
          // before the assistant is allowed to act on it.
          setDraft((prev) =>
            (prev.trim().length === 0 ? text : `${prev.trimEnd()} ${text}`).slice(
              0,
              ASSISTANT_MAX_MESSAGE_CHARS,
            ),
          );
        },
        onError: (error) => {
          setVoiceState('idle');
          setVoiceErrorText(t(voiceErrorKey(assistantErrorCode(error))));
        },
      },
    );
  }, [recorder, recorderState.durationMillis, t, transcribeVoice]);

  // The duration check lives in an effect rather than a timer so it keeps
  // counting from the recorder's own clock, which survives re-renders.
  useEffect(() => {
    if (voiceState !== 'recording') return;
    if (recorderState.durationMillis >= MAX_VOICE_RECORDING_MS) {
      void finishRecording();
    }
  }, [voiceState, recorderState.durationMillis, finishRecording]);

  const startNewConversation = useCallback((): void => {
    setConversationId(null);
    setOpenedConversationId(null);
    setBubbles([]);
    setErrorCode(null);
    setDraft('');
  }, []);

  const openConversation = useCallback((id: string): void => {
    setHistoryOpen(false);
    setErrorCode(null);
    setBubbles([]);
    setOpenedConversationId(id);
  }, []);

  const errorText = useMemo((): string | null => {
    if (errorCode === null) return null;
    const key = ERROR_KEY_BY_CODE[errorCode];
    return key ? t(key) : t('assistant.failedToSend');
  }, [errorCode, t]);

  const hasFailedBubble = bubbles.some((bubble) => bubble.state === 'failed');
  const charsLeft = ASSISTANT_MAX_MESSAGE_CHARS - draft.length;
  const composerDisabled = isSending || notConfigured;
  const isLoadingConversation = conversationQuery.isPending && openedConversationId !== null;
  // The server decides: voice_input stays false until transcription is
  // configured AND the cross-border transfer has been explicitly accepted.
  const voiceAvailable = statusQuery.data?.voice_input === true && !notConfigured;
  const showMicButton = voiceAvailable && draft.trim().length === 0 && voiceState === 'idle';

  const renderBubble = useCallback(
    ({ item }: { item: AssistantBubble }): JSX.Element => {
      const isUser = item.role === 'user';
      return (
        <View style={isUser ? styles.turnUser : styles.turnAssistant}>
          <Text style={styles.turnAuthor}>
            {isUser ? t('assistant.you') : t('assistant.assistantName')}
            {item.created_at !== null && item.state === undefined
              ? ` · ${formatMarketTime(item.created_at)}`
              : ''}
          </Text>
          <View
            style={[
              isUser ? styles.bubbleUser : styles.bubbleAssistant,
              item.state === 'failed' && styles.bubbleFailed,
            ]}
          >
            <Text style={isUser ? styles.bubbleTextUser : styles.bubbleText} selectable>
              {item.content}
            </Text>
          </View>
          {item.state === 'failed' ? <Text style={styles.notSent}>{t('assistant.notSent')}</Text> : null}
          {!isUser ? <ToolActivity calls={item.toolCalls} /> : null}
        </View>
      );
    },
    [styles, t],
  );

  // ── Not connected: the realistic deployment failure ────────────────────────
  const notConfiguredCard = (
    <View style={styles.stateCard}>
      <ServerCog size={30} color={colors.amber} strokeWidth={1.8} />
      <Text style={styles.stateTitle}>{t('assistant.notConfiguredTitle')}</Text>
      <Text style={styles.stateBody}>{t('assistant.notConfiguredBody')}</Text>
      <Text style={styles.stateHint}>{t('assistant.notConfiguredHint')}</Text>
    </View>
  );

  const emptyCard = (
    <View style={styles.empty}>
      <Sparkles size={30} color={colors.orange} strokeWidth={2} />
      <Text style={styles.emptyTitle}>{t('assistant.emptyTitle')}</Text>
      <Text style={styles.emptySubtitle}>{t('assistant.subtitle')}</Text>
      <Text style={styles.emptyHint}>{t('assistant.emptyHint')}</Text>
      {canChat
        ? [t('assistant.example1'), t('assistant.example2'), t('assistant.example3')].map((example) => (
            <TouchableOpacity
              key={example}
              style={styles.exampleChip}
              onPress={() => setDraft(example)}
              accessibilityRole="button"
              accessibilityLabel={example}
            >
              <Text style={styles.exampleText}>{example}</Text>
            </TouchableOpacity>
          ))
        : null}
    </View>
  );

  // Built as an element, not passed as a component type: a fresh function
  // identity on every render would remount the state card (and restart its
  // spinner) each time the draft changes.
  const renderEmptyState = (): JSX.Element => {
    if (statusQuery.isPending) {
      return (
        <View style={styles.stateCard}>
          <ActivityIndicator color={colors.orange} />
          <Text style={styles.stateHint}>{t('assistant.statusChecking')}</Text>
        </View>
      );
    }
    if (statusQuery.isError) {
      return (
        <View style={styles.stateCard}>
          <Text style={styles.stateBody}>{t('assistant.statusFailed')}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => { void statusQuery.refetch(); }}
            accessibilityRole="button"
          >
            <Text style={styles.retryText}>{t('assistant.retry')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (isLoadingConversation) {
      return (
        <View style={styles.stateCard}>
          <ActivityIndicator color={colors.orange} />
        </View>
      );
    }
    // Reopening a stored conversation failed — its own state, not the "cannot
    // send" banner, because nothing was sent.
    if (openedConversationId !== null && conversationQuery.isError) {
      return (
        <View style={styles.stateCard}>
          <Text style={styles.stateBody}>{t('assistant.historyFailed')}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => { void conversationQuery.refetch(); }}
            accessibilityRole="button"
          >
            <Text style={styles.retryText}>{t('assistant.retry')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (notConfigured) return notConfiguredCard;
    return emptyCard;
  };

  return (
    // Root, not nested: behavior="height" measures against the window, so wrapping
    // this in another full-height View leaves the composer under the keyboard.
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
    >
      <Stack.Screen
        options={{
          title: t('assistant.title'),
          headerRight: () => (
            <View style={styles.headerActions}>
              {bubbles.length > 0 ? (
                <TouchableOpacity
                  onPress={startNewConversation}
                  style={styles.headerButton}
                  accessibilityRole="button"
                  accessibilityLabel={t('assistant.newConversation')}
                  hitSlop={8}
                >
                  <Plus size={22} color={colors.orange} strokeWidth={2.2} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={() => setHistoryOpen(true)}
                style={styles.headerButton}
                accessibilityRole="button"
                accessibilityLabel={t('assistant.history')}
                hitSlop={8}
              >
                <History size={22} color={colors.orange} strokeWidth={2.2} />
              </TouchableOpacity>
            </View>
          ),
        }}
      />

        {notConfigured && bubbles.length > 0 ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{t('assistant.notConfigured')}</Text>
          </View>
        ) : null}

        <FlatList
          ref={listRef}
          data={bubbles}
          keyExtractor={(item) => item.key}
          renderItem={renderBubble}
          contentContainerStyle={bubbles.length === 0 ? styles.listEmpty : styles.list}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={renderEmptyState()}
          ListFooterComponent={
            isSending ? (
              <View style={styles.pending}>
                <ActivityIndicator color={colors.orange} />
                <Text style={styles.pendingText}>{t('assistant.thinking')}</Text>
                <Text style={styles.pendingSeconds}>
                  {t('assistant.thinkingElapsed', { count: elapsedSeconds })}
                </Text>
                <Text style={styles.pendingHint}>{t('assistant.longAnswerHint')}</Text>
              </View>
            ) : null
          }
        />

        {errorText !== null && !(isNotConfiguredCode(errorCode) && bubbles.length > 0) ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorText}</Text>
            {hasFailedBubble && !notConfigured ? (
              <TouchableOpacity onPress={handleRetry} accessibilityRole="button" hitSlop={6}>
                <Text style={styles.errorAction}>{t('assistant.retrySend')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {canChat ? (
          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
            {voiceErrorText !== null ? (
              <Text style={styles.errorText}>{voiceErrorText}</Text>
            ) : null}
            {charsLeft <= CHARS_LEFT_WARNING ? (
              <Text style={styles.charsLeft}>{t('assistant.charsLeft', { count: charsLeft })}</Text>
            ) : null}
            {voiceState === 'transcribing' ? (
              <Text style={styles.voiceHint}>{t('assistant.voiceTranscribing')}</Text>
            ) : null}
            {voiceState === 'recording' ? (
              <View style={styles.composerRow}>
                <TouchableOpacity
                  style={styles.voiceCancelButton}
                  onPress={() => { void cancelRecording(); }}
                  accessibilityRole="button"
                  accessibilityLabel={t('assistant.voiceCancel')}
                >
                  <X size={20} color={colors.red} strokeWidth={2.2} />
                </TouchableOpacity>
                <View style={styles.voiceStatus}>
                  <View style={styles.voiceDot} />
                  <Text style={styles.voiceStatusText}>{t('assistant.voiceRecording')}</Text>
                  <Text style={styles.voiceTimer}>
                    {formatVoiceDuration(recorderState.durationMillis)}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.sendButton}
                  onPress={() => { void finishRecording(); }}
                  accessibilityRole="button"
                  accessibilityLabel={t('assistant.voiceStop')}
                >
                  <Check size={18} color="#FFFFFF" strokeWidth={2.4} />
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.composerRow}>
                <TextInput
                  style={styles.input}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={t('assistant.inputPlaceholder')}
                  placeholderTextColor={colors.placeholder}
                  multiline
                  maxLength={ASSISTANT_MAX_MESSAGE_CHARS}
                  editable={!composerDisabled}
                  accessibilityLabel={t('assistant.inputPlaceholder')}
                />
                {voiceState === 'transcribing' ? (
                  <View style={[styles.sendButton, styles.sendButtonDisabled]}>
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  </View>
                ) : showMicButton ? (
                  <TouchableOpacity
                    style={[styles.sendButton, composerDisabled && styles.sendButtonDisabled]}
                    onPress={() => { void startRecording(); }}
                    disabled={composerDisabled}
                    accessibilityRole="button"
                    accessibilityLabel={t('assistant.voiceRecord')}
                  >
                    <Mic size={18} color="#FFFFFF" strokeWidth={2.4} />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[
                      styles.sendButton,
                      (composerDisabled || draft.trim().length === 0) && styles.sendButtonDisabled,
                    ]}
                    onPress={handleSend}
                    disabled={composerDisabled || draft.trim().length === 0}
                    accessibilityRole="button"
                    accessibilityLabel={t('assistant.send')}
                  >
                    {isSending ? (
                      <ActivityIndicator color="#FFFFFF" size="small" />
                    ) : (
                      <Send size={18} color="#FFFFFF" strokeWidth={2.4} />
                    )}
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        ) : (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{t('assistant.readOnlyRole')}</Text>
          </View>
        )}

      <Modal
        visible={historyOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setHistoryOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('assistant.historyTitle')}</Text>

            {conversationsQuery.isPending ? (
              <ActivityIndicator color={colors.orange} style={styles.modalLoader} />
            ) : conversationsQuery.isError ? (
              <View style={styles.modalState}>
                <Text style={styles.errorText}>{t('assistant.historyFailed')}</Text>
                <TouchableOpacity
                  style={styles.retryButton}
                  onPress={() => { void conversationsQuery.refetch(); }}
                  accessibilityRole="button"
                >
                  <Text style={styles.retryText}>{t('assistant.retry')}</Text>
                </TouchableOpacity>
              </View>
            ) : (conversationsQuery.data ?? []).length === 0 ? (
              <Text style={styles.modalEmpty}>{t('assistant.historyEmpty')}</Text>
            ) : (
              <ScrollView style={styles.modalScroll}>
                {(conversationsQuery.data ?? []).map((conversation) => (
                  <TouchableOpacity
                    key={conversation.id}
                    style={styles.historyRow}
                    onPress={() => openConversation(conversation.id)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.historyTitle} numberOfLines={1}>
                      {conversation.title ?? t('assistant.untitled')}
                    </Text>
                    <Text style={styles.historyMeta}>
                      {`${formatMarketDateTime(conversation.updated_at)} · ${t('assistant.messageCount', {
                        count: conversation.message_count,
                      })}`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            <TouchableOpacity
              style={styles.modalPrimary}
              onPress={() => {
                setHistoryOpen(false);
                startNewConversation();
              }}
              accessibilityRole="button"
            >
              <Text style={styles.modalPrimaryText}>{t('assistant.newConversation')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setHistoryOpen(false)}
              accessibilityRole="button"
            >
              <Text style={styles.modalCloseText}>{t('assistant.close')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  headerButton: { padding: 8 },
  banner: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: c.bgPanel,
    borderWidth: 1,
    borderColor: c.border,
  },
  bannerText: { color: c.amber, fontSize: 13, lineHeight: 18 },
  list: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20 },
  listEmpty: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 24 },

  empty: { alignItems: 'center', gap: 10 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: c.text1 },
  emptySubtitle: { fontSize: 14, color: c.amber, textAlign: 'center', lineHeight: 20 },
  emptyHint: { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 19, marginBottom: 4 },
  exampleChip: {
    alignSelf: 'stretch',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  exampleText: { color: c.text1, fontSize: 14, lineHeight: 19 },

  stateCard: {
    alignItems: 'center',
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
    padding: 20,
  },
  stateTitle: { fontSize: 18, fontWeight: '700', color: c.text1, textAlign: 'center' },
  stateBody: { fontSize: 14, color: c.amber, textAlign: 'center', lineHeight: 20 },
  stateHint: { fontSize: 12, color: c.textMuted, textAlign: 'center', lineHeight: 18 },
  retryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryText: { color: c.orange, fontSize: 14, fontWeight: '600' },

  turnUser: { alignItems: 'flex-end', marginBottom: 16 },
  turnAssistant: { alignItems: 'flex-start', marginBottom: 16 },
  turnAuthor: { fontSize: 11, color: c.textMuted, marginBottom: 4, fontWeight: '600' },
  bubbleUser: {
    maxWidth: '92%',
    backgroundColor: c.orange,
    borderRadius: 14,
    borderBottomRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleAssistant: {
    maxWidth: '96%',
    backgroundColor: c.bgPanel,
    borderRadius: 14,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleFailed: { opacity: 0.6 },
  bubbleText: { color: c.text1, fontSize: 15, lineHeight: 21 },
  bubbleTextUser: { color: '#FFFFFF', fontSize: 15, lineHeight: 21 },
  notSent: { fontSize: 11, color: c.red, marginTop: 4 },

  pending: { alignItems: 'center', gap: 6, paddingVertical: 18 },
  pendingText: { color: c.text1, fontSize: 14, fontWeight: '600' },
  pendingSeconds: { color: c.orange, fontSize: 13, fontWeight: '600' },
  pendingHint: { color: c.textMuted, fontSize: 12, textAlign: 'center', paddingHorizontal: 24, lineHeight: 17 },

  errorBox: { paddingHorizontal: 16, paddingBottom: 8, gap: 4 },
  errorText: { color: c.red, fontSize: 13, lineHeight: 18 },
  errorAction: { color: c.orange, fontSize: 13, fontWeight: '700' },

  composer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.bgDark,
    gap: 6,
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  charsLeft: { fontSize: 11, color: c.amber, textAlign: 'right' },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 44,
    borderWidth: 1.5,
    borderColor: c.inputBorder,
    borderRadius: 12,
    backgroundColor: c.inputBg,
    color: c.text1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: c.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.45 },

  voiceCancelButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: c.inputBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceStatus: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 6,
  },
  voiceDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.red },
  voiceStatusText: { color: c.text1, fontSize: 14, fontWeight: '600' },
  voiceTimer: { color: c.amber, fontSize: 14, fontVariant: ['tabular-nums'] },
  voiceHint: { fontSize: 11, color: c.amber, textAlign: 'right' },

  modalBackdrop: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '75%',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: c.text1, marginBottom: 12 },
  modalLoader: { marginVertical: 24 },
  modalState: { alignItems: 'center', gap: 12, paddingVertical: 16 },
  modalEmpty: { fontSize: 14, color: c.amber, textAlign: 'center', paddingVertical: 24 },
  modalScroll: { marginBottom: 8 },
  historyRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  historyTitle: { fontSize: 15, color: c.text1, fontWeight: '600' },
  historyMeta: { fontSize: 12, color: c.amber, marginTop: 3 },
  modalPrimary: {
    marginTop: 4,
    backgroundColor: c.orange,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalPrimaryText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  modalClose: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 20 },
  modalCloseText: { color: c.amber, fontSize: 14 },
});
