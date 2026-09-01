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
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  FlatList,
  Keyboard,
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
import { useHeaderHeight } from '@react-navigation/elements';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertCircle, Check, History, Mic, Plus, Send, ServerCog, Sparkles, X } from 'lucide-react-native';
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
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Card, Button, EmptyState, SkeletonText } from '../../components/ui';

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

/** Pulses the recording dot so "live" reads as live, not as a static icon.
 * Honors the OS reduce-motion setting like the Skeleton primitive does. */
function useRecordingPulse(active: boolean): Animated.Value {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) {
      pulse.setValue(1);
      return;
    }
    let cancelled = false;
    let loop: Animated.CompositeAnimation | null = null;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((reduced) => {
        if (cancelled || reduced) return;
        loop = Animated.loop(
          Animated.sequence([
            Animated.timing(pulse, { toValue: 0.3, duration: 600, useNativeDriver: true }),
            Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
          ]),
        );
        loop.start();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [active, pulse]);

  return pulse;
}

/** Two placeholder turns shaped like the real transcript — used while the
 * status probe or a stored conversation is still loading. */
function ChatSkeleton(): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  return (
    <View style={styles.chatSkeletonWrap}>
      <View style={styles.turnAssistant}>
        <View style={styles.bubbleAssistant}>
          <SkeletonText lines={2} lastLineWidth="70%" />
        </View>
      </View>
      <View style={styles.turnAssistant}>
        <View style={[styles.bubbleAssistant, styles.chatSkeletonNarrow]}>
          <SkeletonText lines={1} lastLineWidth="55%" />
        </View>
      </View>
    </View>
  );
}

export default function AssistantScreen(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  // edgeToEdgeEnabled is on, so the app draws under the transparent system navigation
  // bar. Without padding the composer for that inset, the bar area shows the window
  // background instead of ours — a white strip under the input on gesture-nav devices.
  const insets = useSafeAreaInsets();
  // The native header (Stack.Screen below) isn't part of this view's RN
  // subtree, so KeyboardAvoidingView's own layout measurement doesn't know
  // about it. Without subtracting it here, "padding" behavior overcompensates
  // by the header's height — a dead gap between the composer and the keyboard.
  const headerHeight = useHeaderHeight();
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

  // The composer's bottom padding exists for the home-indicator safe area when
  // the keyboard is closed. With the keyboard open, that same padding just
  // shows up as dead space between the input row and the keyboard — the
  // keyboard itself already covers that area, so drop the padding while it's
  // up.
  const [keyboardVisible, setKeyboardVisible] = useState<boolean>(false);
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const statusQuery = useAssistantStatus();
  const conversationsQuery = useAssistantConversations(historyOpen);
  const conversationQuery = useAssistantConversation(openedConversationId);
  const sendMutation = useSendAssistantMessage();

  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceErrorText, setVoiceErrorText] = useState<string | null>(null);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder);
  const { mutate: transcribeVoice } = useTranscribeVoice();
  // The 120s auto-stop polls the same clock the stop button reads, so both can
  // fire for one recording. Without this latch the second caller stops an
  // already-stopped recorder and uploads the same file a second time.
  const finishingRef = useRef(false);
  const recordingPulse = useRecordingPulse(voiceState === 'recording');

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
      finishingRef.current = false;
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
    finishingRef.current = false;
    setVoiceState('idle');
    try {
      await recorder.stop();
    } catch {
      // Already stopped (auto-stop raced the tap) — nothing to clean up.
    }
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
  }, [recorder]);

  const finishRecording = useCallback(async (): Promise<void> => {
    if (finishingRef.current) return;
    finishingRef.current = true;

    // getStatus(), not recorderState: the hook's durationMillis is a snapshot
    // polled every 500ms, so at the moment of the tap it can still read 0 for a
    // recording that really lasted a second — and a real message would then be
    // dropped by the accidental-tap guard below with no error and no upload.
    let durationMs = recorderState.durationMillis;
    try {
      durationMs = Math.max(durationMs, recorder.getStatus().durationMillis);
    } catch {
      // Recorder already torn down — the polled value is the best we have.
    }

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
      finishingRef.current = false;
      setVoiceState('idle');
      return;
    }
    if (uri === null) {
      finishingRef.current = false;
      setVoiceState('idle');
      setVoiceErrorText(t('assistant.voiceRecordFailed'));
      return;
    }

    setVoiceState('transcribing');
    transcribeVoice(
      // Whisper is told which language to expect. Left to the server default it
      // hears Russian in everything, and an English command comes back as
      // confident transliterated nonsense rather than as an error.
      { uri, language: i18n.language },
      {
        onSuccess: ({ text }) => {
          finishingRef.current = false;
          setVoiceState('idle');
          if (text.length === 0) {
            setVoiceErrorText(t('assistant.voiceEmpty'));
            return;
          }
          // Sent, not parked: dictating a command and then having to tap send
          // again defeats the point of speaking to the assistant (owner call,
          // 2026-09-01). What makes this safe is the hallucination guard in
          // backend/services/transcription.ts — audio with no intelligible
          // speech arrives here as '' and is reported below instead of being
          // turned into an instruction nobody gave.
          const combined = (
            draft.trim().length === 0 ? text : `${draft.trimEnd()} ${text}`
          ).slice(0, ASSISTANT_MAX_MESSAGE_CHARS);
          setDraft('');
          submit(combined);
        },
        onError: (error) => {
          finishingRef.current = false;
          setVoiceState('idle');
          setVoiceErrorText(t(voiceErrorKey(assistantErrorCode(error))));
        },
      },
    );
  }, [recorder, recorderState.durationMillis, draft, submit, t, i18n.language, transcribeVoice]);

  // The duration check lives in an effect rather than a timer so it keeps
  // counting from the recorder's own clock, which survives re-renders.
  useEffect(() => {
    if (voiceState !== 'recording') return;
    if (recorderState.durationMillis >= MAX_VOICE_RECORDING_MS) {
      void finishRecording();
    }
  }, [voiceState, recorderState.durationMillis, finishRecording]);

  // ── Voice hot button on the dashboard: /assistant?voice=1 ─────────────────
  // Arriving through it means the user is already mid-thought, so the recorder
  // starts as soon as the server confirms voice is available — one tap on the
  // dashboard, speak, review the transcript, send. Guarded by a ref so a
  // re-render (or a later manual cancel) never restarts recording, and once
  // the status resolves WITHOUT voice the attempt is marked spent rather than
  // retried forever. Everything after the start is the ordinary voice flow.
  const { voice: voiceParam } = useLocalSearchParams<{ voice?: string }>();
  const autoVoiceRef = useRef(false);
  useEffect(() => {
    if (autoVoiceRef.current || voiceParam !== '1' || !canChat) return;
    if (statusQuery.data === undefined) return; // status still loading — wait
    autoVoiceRef.current = true;
    if (statusQuery.data.voice_input !== true || notConfigured) return;
    if (voiceState !== 'idle') return;
    void startRecording();
  }, [voiceParam, canChat, statusQuery.data, notConfigured, voiceState, startRecording]);

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
    <EmptyState
      icon={<ServerCog size={30} color={colors.warning} strokeWidth={1.8} />}
      title={t('assistant.notConfiguredTitle')}
      description={`${t('assistant.notConfiguredBody')}\n${t('assistant.notConfiguredHint')}`}
    />
  );

  const emptyCard = (
    <View>
      <EmptyState
        icon={<Sparkles size={30} color={colors.accent} strokeWidth={2} />}
        title={t('assistant.emptyTitle')}
        description={`${t('assistant.subtitle')}\n${t('assistant.emptyHint')}`}
      />
      {canChat
        ? [t('assistant.example1'), t('assistant.example2'), t('assistant.example3')].map((example) => (
            <TouchableOpacity
              key={example}
              style={styles.exampleChip}
              onPress={() => setDraft(example)}
              accessibilityRole="button"
              accessibilityLabel={example}
              activeOpacity={0.7}
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
      return <ChatSkeleton />;
    }
    if (statusQuery.isError) {
      return (
        <EmptyState
          icon={<AlertCircle size={28} color={colors.danger} />}
          title={t('assistant.statusFailed')}
          actionLabel={t('assistant.retry')}
          onAction={() => { void statusQuery.refetch(); }}
        />
      );
    }
    if (isLoadingConversation) {
      return <ChatSkeleton />;
    }
    // Reopening a stored conversation failed — its own state, not the "cannot
    // send" banner, because nothing was sent.
    if (openedConversationId !== null && conversationQuery.isError) {
      return (
        <EmptyState
          icon={<AlertCircle size={28} color={colors.danger} />}
          title={t('assistant.historyFailed')}
          actionLabel={t('assistant.retry')}
          onAction={() => { void conversationQuery.refetch(); }}
        />
      );
    }
    if (notConfigured) return notConfiguredCard;
    return emptyCard;
  };

  return (
    // Root, not nested: behavior="height" measures against the window, so wrapping
    // this in another full-height View leaves the composer under the keyboard.
    //
    // Android gets no behavior at all: the manifest sets
    // windowSoftInputMode="adjustResize", so the OS already shrinks the window
    // by the keyboard's height. Adding behavior="height" here shrinks it a
    // second time, which is the huge dead gap that used to sit between the
    // composer and the keyboard.
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
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
                  activeOpacity={0.7}
                >
                  <Plus size={22} color={colors.accent} strokeWidth={2.2} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={() => setHistoryOpen(true)}
                style={styles.headerButton}
                accessibilityRole="button"
                accessibilityLabel={t('assistant.history')}
                hitSlop={8}
                activeOpacity={0.7}
              >
                <History size={22} color={colors.accent} strokeWidth={2.2} />
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
                <ActivityIndicator color={colors.accent} />
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
              <TouchableOpacity onPress={handleRetry} accessibilityRole="button" hitSlop={6} activeOpacity={0.7}>
                <Text style={styles.errorAction}>{t('assistant.retrySend')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {canChat ? (
          <View
            style={[
              styles.composer,
              { paddingBottom: keyboardVisible ? spacing.sm : Math.max(insets.bottom, spacing.md + 2) },
            ]}
          >
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
                  activeOpacity={0.7}
                >
                  <X size={20} color={colors.danger} strokeWidth={2.2} />
                </TouchableOpacity>
                <View style={styles.voiceStatus}>
                  <Animated.View style={[styles.voiceDot, { opacity: recordingPulse }]} />
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
                  activeOpacity={0.7}
                >
                  <Check size={18} color={colors.onAccent} strokeWidth={2.4} />
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
                    <ActivityIndicator color={colors.onAccent} size="small" />
                  </View>
                ) : showMicButton ? (
                  <TouchableOpacity
                    style={[styles.sendButton, composerDisabled && styles.sendButtonDisabled]}
                    onPress={() => { void startRecording(); }}
                    disabled={composerDisabled}
                    accessibilityRole="button"
                    accessibilityLabel={t('assistant.voiceRecord')}
                    activeOpacity={0.7}
                  >
                    <Mic size={18} color={colors.onAccent} strokeWidth={2.4} />
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
                    activeOpacity={0.7}
                  >
                    {isSending ? (
                      <ActivityIndicator color={colors.onAccent} size="small" />
                    ) : (
                      <Send size={18} color={colors.onAccent} strokeWidth={2.4} />
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
              <View style={styles.modalSkeletonWrap}>
                <SkeletonText lines={2} lastLineWidth="60%" />
                <SkeletonText lines={2} lastLineWidth="45%" />
              </View>
            ) : conversationsQuery.isError ? (
              <EmptyState
                icon={<AlertCircle size={28} color={colors.danger} />}
                title={t('assistant.historyFailed')}
                actionLabel={t('assistant.retry')}
                onAction={() => { void conversationsQuery.refetch(); }}
              />
            ) : (conversationsQuery.data ?? []).length === 0 ? (
              <EmptyState
                icon={<History size={28} color={colors.textMuted} />}
                title={t('assistant.historyEmpty')}
              />
            ) : (
              <ScrollView style={styles.modalScroll}>
                {(conversationsQuery.data ?? []).map((conversation) => (
                  <Card
                    key={conversation.id}
                    style={styles.historyRow}
                    onPress={() => openConversation(conversation.id)}
                    accessibilityLabel={conversation.title ?? t('assistant.untitled')}
                  >
                    <Text style={styles.historyTitle} numberOfLines={1}>
                      {conversation.title ?? t('assistant.untitled')}
                    </Text>
                    <Text style={styles.historyMeta}>
                      {`${formatMarketDateTime(conversation.updated_at)} · ${t('assistant.messageCount', {
                        count: conversation.message_count,
                      })}`}
                    </Text>
                  </Card>
                ))}
              </ScrollView>
            )}

            <Button
              title={t('assistant.newConversation')}
              onPress={() => {
                setHistoryOpen(false);
                startNewConversation();
              }}
              block
              style={styles.modalPrimary}
            />
            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setHistoryOpen(false)}
              accessibilityRole="button"
              activeOpacity={0.7}
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
  headerButton: { padding: spacing.sm },
  banner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: c.bgPanel,
    borderWidth: 1,
    borderColor: c.border,
  },
  bannerText: { color: c.textMuted, ...type.label, lineHeight: 18 },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xl },
  listEmpty: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.xl },

  chatSkeletonWrap: { gap: spacing.sm },
  chatSkeletonNarrow: { maxWidth: '70%' },

  exampleChip: {
    alignSelf: 'stretch',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  exampleText: { color: c.text1, ...type.body, lineHeight: 19 },

  turnUser: { alignItems: 'flex-end', marginBottom: spacing.lg },
  turnAssistant: { alignItems: 'flex-start', marginBottom: spacing.lg },
  turnAuthor: { ...type.micro, color: c.textMuted, marginBottom: spacing.xs },
  bubbleUser: {
    maxWidth: '92%',
    backgroundColor: c.accent,
    borderRadius: radius.xl,
    borderBottomRightRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleAssistant: {
    maxWidth: '96%',
    backgroundColor: c.bgPanel,
    borderRadius: radius.xl,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleFailed: { opacity: 0.6 },
  bubbleText: { color: c.text1, ...type.body, lineHeight: 21 },
  bubbleTextUser: { color: c.onAccent, ...type.body, lineHeight: 21 },
  notSent: { ...type.micro, color: c.danger, marginTop: spacing.xs },

  pending: { alignItems: 'center', gap: spacing.sm - 2, paddingVertical: spacing.lg + 2 },
  pendingText: { color: c.text1, ...type.body, fontWeight: '600' },
  pendingSeconds: { color: c.accent, ...type.label, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pendingHint: { color: c.textMuted, ...type.caption, textAlign: 'center', paddingHorizontal: spacing.xl, lineHeight: 17 },

  errorBox: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.xs },
  errorText: { color: c.danger, ...type.label, lineHeight: 18 },
  errorAction: { color: c.accent, ...type.label, fontWeight: '700' },

  composer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.bgDark,
    gap: spacing.sm - 2,
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  charsLeft: { ...type.micro, color: c.warning, textAlign: 'right', fontVariant: ['tabular-nums'] },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 44,
    borderWidth: 1.5,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    backgroundColor: c.inputBg,
    color: c.text1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...type.body,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.45 },

  voiceCancelButton: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: c.inputBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceStatus: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.xs + 2,
  },
  voiceDot: { width: 10, height: 10, borderRadius: radius.sm, backgroundColor: c.danger },
  voiceStatusText: { color: c.text1, ...type.body, fontWeight: '600' },
  voiceTimer: { color: c.textMuted, ...type.body, fontVariant: ['tabular-nums'] },
  voiceHint: { ...type.micro, color: c.textMuted, textAlign: 'right' },

  modalBackdrop: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.xl,
    maxHeight: '75%',
  },
  modalTitle: { ...type.subtitle, color: c.text1, marginBottom: spacing.md },
  modalSkeletonWrap: { gap: spacing.md, paddingVertical: spacing.md },
  modalScroll: { marginBottom: spacing.sm },
  historyRow: { marginBottom: spacing.sm },
  historyTitle: { ...type.body, color: c.text1, fontWeight: '600' },
  historyMeta: { ...type.caption, color: c.textMuted, marginTop: spacing.xs, fontVariant: ['tabular-nums'] },
  modalPrimary: {
    marginTop: spacing.xs,
  },
  modalClose: { alignSelf: 'center', paddingVertical: spacing.sm, paddingHorizontal: spacing.xl },
  modalCloseText: { color: c.textMuted, ...type.caption },
});
