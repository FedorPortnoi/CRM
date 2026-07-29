import { useState, useCallback, useEffect } from 'react';
import { ActivityIndicator, StyleSheet, ScrollView, View, Text, TouchableOpacity, RefreshControl, Linking, Alert, ActionSheetIOS, Platform } from 'react-native';
import { Stack, useLocalSearchParams, router } from 'expo-router';
import { MessageCircle, Sparkles } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { formatMarketDate, formatMarketTime, formatMoney } from '../../market/profile';
import AttachmentsSection from '../../components/AttachmentsSection';
import ContactConsentCard from '../../components/ContactConsentCard';
import { useAuditLog } from '../../hooks/useAuditLog';
import {
  contactAiErrorCode,
  isContactAiOffCode,
  roleCanUseContactAi,
  useAssistantStatus,
  useContactSummary,
  type ContactAiErrorCode,
} from '../../hooks/useContactAi';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

interface Attachment {
  id: string;
  filename: string;
  file_url: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
}

interface Assignee { id: string; name: string; }

interface Contact {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  tags: string[] | null;
  status: string;
  notes: string | null;
  type: string | null;
  assignee: Assignee | null;
}

interface ActivityItem { type: 'message' | 'task' | 'meeting'; id: string; summary: string; created_at: string; }
interface ActivityData { contact_id: string; items: ActivityItem[]; }
interface DealStage { id: string; name: string; position: number; }
interface DealPipeline { id: string; name: string; }
interface Deal { id: string; title: string; value: number | null; currency: string | null; status: string; stage: DealStage | null; pipeline: DealPipeline | null; }

interface Task { id: string; title: string; status: 'pending' | 'in_progress' | 'done' | 'cancelled'; due_date: string | null; priority: 'low' | 'medium' | 'high' | 'urgent'; }

function formatValue(value: number | null, currency: string | null): string {
  return formatMoney(value, currency, { empty: '—' });
}

function formatDate(dateStr: string): string {
  return formatMarketDate(dateStr, { month: 'short', day: 'numeric', year: 'numeric' });
}

function isOverdue(due_date: string | null, status: string): boolean {
  if (!due_date) return false;
  if (status === 'done' || status === 'cancelled') return false;
  return new Date(due_date) < new Date();
}
function activityIcon(type: 'message' | 'task' | 'meeting'): string {
  if (type === 'message') return '💬';
  if (type === 'task') return '✓';
  return '📅';
}

function statusBadgeColor(status: string, c: ThemeColors): string {
  if (status === 'active') return c.orange;
  if (status === 'inactive') return '#E8A000';
  return c.textMuted;
}

function taskBadgeColor(status: 'pending' | 'in_progress' | 'done' | 'cancelled', c: ThemeColors): string {
  if (status === 'done') return c.orange;
  if (status === 'in_progress') return c.orange;
  if (status === 'pending') return '#E8A000';
  return c.textMuted;
}

// The AI summary fails with a CODE; the server's message is operator-facing English
// («the service account is missing ai.languageModels.user») and is never rendered. An
// unmapped code falls through to contactAi.failed rather than putting AI_SOMETHING_NEW
// on screen.
const AI_ERROR_KEY_BY_CODE: Record<string, string> = {
  SERVICE_NOT_CONFIGURED: 'contactAi.notConfigured',
  AI_TIMEOUT: 'contactAi.timeout',
  AI_RATE_LIMITED: 'contactAi.rateLimited',
  AI_EMPTY_RESPONSE: 'contactAi.unavailable',
  AI_INVALID_RESPONSE: 'contactAi.unavailable',
  AI_REQUEST_FAILED: 'contactAi.unavailable',
  NOT_FOUND: 'contactAi.notFound',
  // On this route both mean the id in the URL is not a uuid the server will accept, which
  // for the person reading the card is the same fact as "no such contact".
  VALIDATION_ERROR: 'contactAi.notFound',
  INVALID_ID: 'contactAi.notFound',
  // Reachable only if the role gate in useContactAi drifts from capabilities.ts — the
  // POST is refused for a role holding no write capability.
  FORBIDDEN: 'contactAi.readOnlyRole',
  UNAUTHORIZED: 'errors.unauthorized',
  NETWORK_ERROR: 'errors.networkError',
};

interface SkeletonBoxProps { width: number; height: number; borderRadius?: number; marginRight?: number; marginBottom?: number; }

function SkeletonBox({ width, height, borderRadius = 4, marginRight = 0, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return <View style={{ width, height, backgroundColor: 'rgba(204,120,92,0.08)', borderRadius, marginRight, marginBottom }} />;
}

export default function ContactDetailScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);
  const role = useUserStore((s) => s.user?.role);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [contact, setContact] = useState<Contact | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [dealsError, setDealsError] = useState<string | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const { data: auditLog = [] } = useAuditLog('contact', id);
  const headers = { Authorization: 'Bearer ' + token };

  // ── AI summary (POST /api/v1/ai/contacts/:id/summary) ──────────────────────
  // Held in the mutation, not in state and not in a query: the summary retells this
  // contact's history, and query results are dehydrated into the plaintext AsyncStorage
  // cache while mutation results are not.
  const aiStatus = useAssistantStatus();
  const summaryMutation = useContactSummary(id);
  const aiSummary = summaryMutation.data ?? null;
  const aiErrorCode: ContactAiErrorCode | null = summaryMutation.isError
    ? contactAiErrorCode(summaryMutation.error)
    : null;
  // Rendered only once the provider is known reachable AND this role may POST at all AND
  // the contact itself has loaded — a summary of a record we could not even read would
  // just earn the same 404. An unconfirmed probe — still pending, or failed because the
  // device is offline — counts as "off": on a contact card the summary is an accessory,
  // so a button that cannot work is worse than no section, and a broken provider gets
  // diagnosed on the assistant screen, not here.
  const showAiSection =
    contact !== null && roleCanUseContactAi(role) && aiStatus.data?.configured === true;
  // `configured` only reports that the env vars exist. A service account without
  // ai.languageModels.user answers `true` and fails on the first real attempt — so that
  // failure has to take the button away too, or it stays an invitation to retry forever.
  const aiOff = isContactAiOffCode(aiErrorCode);
  const aiErrorText =
    aiErrorCode === null ? null : t(AI_ERROR_KEY_BY_CODE[aiErrorCode] ?? 'contactAi.failed');

  const fetchAll = useCallback(async (refreshing: boolean, signal?: AbortSignal): Promise<void> => {
    if (refreshing) { setIsRefreshing(true); } else { setIsLoading(true); }
    await Promise.all([
      fetch(API_URL + '/contacts/' + id, { headers, signal })
        .then(async (res) => {
          if (signal?.aborted) return;
          if (!res.ok) { const b = (await res.json()) as { error: { message: string } }; setContactError(b.error.message); return; }
          const b = (await res.json()) as { data: Contact };
          setContact(b.data); setContactError(null);
        })
        .catch((e: unknown) => { if ((e as Error)?.name !== 'AbortError') setContactError('Ошибка загрузки контакта'); }),
      fetch(API_URL + '/contacts/' + id + '/activity', { headers, signal })
        .then(async (res) => {
          if (signal?.aborted) return;
          if (!res.ok) { setActivityError('Ошибка загрузки активности'); return; }
          const b = (await res.json()) as { data: ActivityData };
          setActivity(b.data); setActivityError(null);
        })
        .catch((e: unknown) => { if ((e as Error)?.name !== 'AbortError') setActivityError('Ошибка загрузки активности'); }),
      fetch(API_URL + '/contacts/' + id + '/deals', { headers, signal })
        .then(async (res) => {
          if (signal?.aborted) return;
          if (!res.ok) { setDealsError('Ошибка загрузки сделок'); return; }
          const b = (await res.json()) as { data: Deal[] };
          setDeals(b.data); setDealsError(null);
        })
        .catch((e: unknown) => { if ((e as Error)?.name !== 'AbortError') setDealsError('Ошибка загрузки сделок'); }),
      fetch(API_URL + '/contacts/' + id + '/tasks', { headers, signal })
        .then(async (res) => {
          if (signal?.aborted) return;
          if (!res.ok) { setTasksError('Ошибка загрузки задач'); return; }
          const b = (await res.json()) as { data: Task[] };
          setTasks(b.data); setTasksError(null);
        })
        .catch((e: unknown) => { if ((e as Error)?.name !== 'AbortError') setTasksError('Ошибка загрузки задач'); }),
    ]);
    if (!signal?.aborted) { setIsLoading(false); setIsRefreshing(false); }
  }, [id, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const controller = new AbortController();
    void fetchAll(false, controller.signal);
    return () => controller.abort();
  }, [fetchAll]);

  const onRefresh = useCallback((): void => { void fetchAll(true); }, [fetchAll]);
  const contactName = contact
    ? contact.last_name ? contact.first_name + ' ' + contact.last_name : contact.first_name
    : '';

  return (
    <>
      <Stack.Screen
        options={{
          title: contactName || 'Contact',
          headerBackTitle: 'Contacts',
          headerRight: () => (
            contact ? (
              <TouchableOpacity
                style={styles.headerEditButton}
                onPress={() => router.push({ pathname: '/contact/edit/[id]', params: { id } })}
                activeOpacity={0.7}
              >
                <Text style={styles.headerEditText}>{t('common.edit')}</Text>
              </TouchableOpacity>
            ) : null
          ),
        }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.orange} />}
      >
        <View style={styles.card}>
          {isLoading ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <SkeletonBox width={60} height={60} borderRadius={30} marginRight={12} />
              <View style={{ flex: 1 }}>
                <SkeletonBox width={180} height={16} marginBottom={8} />
                <SkeletonBox width={130} height={12} />
              </View>
            </View>
          ) : contactError ? (
            <View>
              <Text style={styles.errorText}>{contactError}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={onRefresh}>
                <Text style={styles.retryText}>{t('common.retry')}</Text>
              </TouchableOpacity>
            </View>
          ) : contact ? (
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{contact.first_name.charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.contactName}>{contactName}</Text>
                  {contact.company ? <Text style={styles.secondaryText}>{contact.company}</Text> : null}
                  <View style={[styles.statusBadge, { backgroundColor: statusBadgeColor(contact.status, colors) }]}>
                    <Text style={styles.badgeText}>{contact.status === 'active' ? t('contacts.statusActive') : contact.status === 'inactive' ? t('contacts.statusInactive') : contact.status}</Text>
                  </View>
                </View>
              </View>
              {(contact.phone || contact.mobile || contact.email) ? (
                <View style={styles.detailRows}>
                  {contact.phone ? (
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>{t('contacts.phone')}</Text>
                      <Text style={styles.detailValue}>{contact.phone}</Text>
                    </View>
                  ) : null}
                  {contact.mobile ? (
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>{t('contacts.mobile')}</Text>
                      <Text style={styles.detailValue}>{contact.mobile}</Text>
                    </View>
                  ) : null}
                  {contact.email ? (
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>{t('contacts.email')}</Text>
                      <Text style={styles.detailValue}>{contact.email}</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
              <TouchableOpacity
                style={styles.conversationButton}
                onPress={() => {
                  const phone = contact?.phone ?? contact?.mobile ?? null;
                  if (!phone) { Alert.alert('', t('contacts.noPhone')); return; }
                  const clean = phone.replace(/[^\d+]/g, '');
                  const digits = clean.replace(/^\+/, '');
                  const options = [t('contacts.smsMessages'), 'Telegram', 'MAX', t('contacts.cancel')];
                  if (Platform.OS === 'ios') {
                    ActionSheetIOS.showActionSheetWithOptions(
                      { options, cancelButtonIndex: 3, title: t('contacts.chooseMessenger') },
                      (idx) => {
                        if (idx === 0) void Linking.openURL(`sms:${clean}`);
                        else if (idx === 1) void Linking.openURL(`tg://resolve?phone=${digits}`);
                        else if (idx === 2) void Linking.openURL(`vkme://chat/by_phone?phone=${clean}`).catch(() => Linking.openURL(`https://vk.me/${digits}`));
                      },
                    );
                  } else {
                    Alert.alert(t('contacts.chooseMessenger'), undefined, [
                      { text: t('contacts.smsMessages'), onPress: () => void Linking.openURL(`sms:${clean}`) },
                      { text: 'Telegram', onPress: () => void Linking.openURL(`tg://resolve?phone=${digits}`) },
                      { text: 'MAX', onPress: () => void Linking.openURL(`vkme://chat/by_phone?phone=${clean}`).catch(() => Linking.openURL(`https://vk.me/${digits}`)) },
                      { text: t('contacts.cancel'), style: 'cancel' },
                    ]);
                  }
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <MessageCircle size={18} color="#FFFFFF" />
                <Text style={styles.conversationButtonText}>{t('contacts.conversation')}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        {/* Consent sits directly under the contact's own details: it is a fact about this
            person, and the ФЗ-38 evidence has to be as visible as their phone number.
            Rendered only once the contact has loaded so `email` is known rather than
            momentarily absent. */}
        {contact ? <ContactConsentCard contactId={contact.id} contactEmail={contact.email} /> : null}

        {/* Above the raw activity feed on purpose: the summary exists to save reading that
            feed, so placing it under the thing it replaces would bury it. Nothing is
            generated until asked — every call spends model quota. */}
        {showAiSection ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('contactAi.title')}</Text>
            <View style={[styles.card, styles.aiCard]}>
              {summaryMutation.isPending ? (
                <>
                  <View style={styles.aiLoadingRow}>
                    <ActivityIndicator color={colors.orange} />
                    <Text style={styles.aiHint}>{t('contactAi.generating')}</Text>
                  </View>
                  <Text style={styles.aiNote}>{t('contactAi.generatingHint')}</Text>
                </>
              ) : aiSummary ? (
                <>
                  <Text style={styles.aiSummaryText} selectable>{aiSummary.summary}</Text>
                  {aiSummary.next_action ? (
                    <View style={styles.aiNextAction}>
                      <Text style={styles.aiNextActionLabel}>{t('contactAi.nextActionLabel')}</Text>
                      <Text style={styles.aiNextActionText} selectable>{aiSummary.next_action}</Text>
                    </View>
                  ) : null}
                  {/* What the model was actually given, the way the assistant screen shows
                      what it actually did: prose is not evidence on its own. */}
                  <Text style={styles.aiNote}>
                    {t('contactAi.basis', {
                      deals: aiSummary.context_counts.deals,
                      tasks: aiSummary.context_counts.tasks,
                      activities: aiSummary.context_counts.activities,
                    })}
                  </Text>
                  <Text style={styles.aiNote}>
                    {t('contactAi.generatedAt', {
                      time: formatMarketTime(aiSummary.generated_at),
                      provider: aiSummary.provider,
                    })}
                  </Text>
                </>
              ) : (
                <Text style={styles.aiHint}>{t('contactAi.intro')}</Text>
              )}

              {aiErrorText !== null ? <Text style={styles.errorText}>{aiErrorText}</Text> : null}
              {aiOff ? <Text style={styles.aiNote}>{t('contactAi.notConfiguredHint')}</Text> : null}

              {!summaryMutation.isPending && !aiOff ? (
                <TouchableOpacity
                  style={aiSummary ? styles.aiSecondaryButton : styles.aiButton}
                  onPress={() => summaryMutation.mutate()}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                >
                  {aiSummary ? null : <Sparkles size={16} color="#FFFFFF" strokeWidth={2.2} />}
                  <Text style={aiSummary ? styles.aiSecondaryButtonText : styles.aiButtonText}>
                    {aiSummary ? t('contactAi.regenerate') : t('contactAi.generate')}
                  </Text>
                </TouchableOpacity>
              ) : null}

              {aiSummary ? <Text style={styles.aiNote}>{t('contactAi.disclaimer')}</Text> : null}
              {/* True structurally, not by promise: backend/services/contact-ai.ts never
                  reads the email/phone columns and masks anything phone- or
                  address-shaped out of the free text (ФЗ-152 ст. 5 ч. 5). */}
              <Text style={styles.aiNote}>{t('contactAi.privacyNote')}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('contacts.activity')}</Text>
          <View style={styles.card}>
            {isLoading ? (
              <>
                {[0, 1, 2].map((i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                    <SkeletonBox width={32} height={32} borderRadius={16} marginRight={10} />
                    <View style={{ flex: 1 }}>
                      <SkeletonBox width={200} height={12} marginBottom={6} />
                      <SkeletonBox width={100} height={10} />
                    </View>
                  </View>
                ))}
              </>
            ) : activityError ? (
              <View>
                <Text style={styles.errorText}>{activityError}</Text>
                <TouchableOpacity style={styles.retryButton} onPress={onRefresh}>
                  <Text style={styles.retryText}>{t('common.retry')}</Text>
                </TouchableOpacity>
              </View>
            ) : !activity || activity.items.length === 0 ? (
              <Text style={styles.emptyText}>{t('contacts.noActivity')}</Text>
            ) : (
              activity.items.slice(0, 20).map((item) => (
                <View key={item.id} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 }}>
                  <Text style={{ fontSize: 18, marginRight: 10, marginTop: 1 }}>{activityIcon(item.type)}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.activitySummary} numberOfLines={2}>{item.summary}</Text>
                    <Text style={styles.activityDate}>{formatDate(item.created_at)}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('contacts.deals')}</Text>
          {isLoading ? (
            <>
              {[0, 1].map((i) => (
                <View key={i} style={[styles.card, { marginBottom: 8 }]}>
                  <SkeletonBox width={160} height={14} marginBottom={8} />
                  <SkeletonBox width={100} height={10} />
                </View>
              ))}
            </>
          ) : dealsError ? (
            <View style={styles.card}>
              <Text style={styles.errorText}>{dealsError}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={onRefresh}>
                <Text style={styles.retryText}>{t('common.retry')}</Text>
              </TouchableOpacity>
            </View>
          ) : !deals || deals.length === 0 ? (
            <View style={styles.card}><Text style={styles.emptyText}>{t('contacts.noDeals')}</Text></View>
          ) : (
            deals.map((deal) => (
              <View key={deal.id} style={[styles.card, { marginBottom: 8 }]}>
                <Text style={styles.dealTitle}>{deal.title}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  {deal.stage ? (
                    <View style={styles.stageBadge}>
                      <Text style={styles.stageBadgeText}>{deal.stage.name}</Text>
                    </View>
                  ) : null}
                  <Text style={styles.dealValue}>{formatValue(deal.value, deal.currency)}</Text>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t('contacts.tasks')}</Text>
            {contact ? (
              <TouchableOpacity
                onPress={() => router.push({
                  pathname: '/task/new',
                  params: {
                    contact_id: id,
                    contact_name: `${contact.first_name}${contact.last_name ? ' ' + contact.last_name : ''}`,
                  },
                })}
                accessibilityRole="button"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.sectionAddBtn}>+ {t('tasks.addTask')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {isLoading ? (
            <>
              {[0, 1].map((i) => (
                <View key={i} style={[styles.card, { marginBottom: 8 }]}>
                  <SkeletonBox width={170} height={14} marginBottom={8} />
                  <SkeletonBox width={90} height={10} />
                </View>
              ))}
            </>
          ) : tasksError ? (
            <View style={styles.card}>
              <Text style={styles.errorText}>{tasksError}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={onRefresh}>
                <Text style={styles.retryText}>{t('common.retry')}</Text>
              </TouchableOpacity>
            </View>
          ) : !tasks || tasks.length === 0 ? (
            <View style={styles.card}><Text style={styles.emptyText}>{t('contacts.noTasks')}</Text></View>
          ) : (
            tasks.map((task) => (
              <TouchableOpacity
                key={task.id}
                style={[styles.card, { marginBottom: 8 }]}
                onPress={() => router.push({ pathname: '/task/[id]', params: { id: task.id } })}
                activeOpacity={0.7}
              >
                <Text style={styles.taskTitle}>{task.title}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={[styles.taskBadge, { backgroundColor: taskBadgeColor(task.status, colors) }]}>
                    <Text style={styles.badgeText}>{task.status === 'pending' ? t('tasks.pending') : task.status === 'in_progress' ? t('tasks.inProgress') : task.status === 'done' ? t('tasks.completed') : t('tasks.cancelled')}</Text>
                  </View>
                  {task.due_date ? (
                    <Text style={[styles.taskDueDate, isOverdue(task.due_date, task.status) ? styles.overdueText : null]}>
                      {formatDate(task.due_date)}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('contacts.activityLog')}</Text>
          {auditLog.length === 0 ? (
            <Text style={styles.emptyText}>{t('contacts.noActivity')}</Text>
          ) : auditLog.map((entry) => (
            <View key={entry.id} style={styles.auditRow}>
              <View style={[styles.auditBadge, { backgroundColor: entry.action === 'created' ? 'rgba(204,120,92,0.08)' : entry.action === 'updated' ? '#dbeafe' : colors.bg }]}>
                <Text style={[styles.auditBadgeText, { color: entry.action === 'created' ? colors.orange : entry.action === 'updated' ? '#1d4ed8' : colors.text1 }]}>{entry.action === 'created' ? t('contacts.actionCreated') : entry.action === 'updated' ? t('contacts.actionUpdated') : entry.action}</Text>
              </View>
              <Text style={styles.auditDate}>{new Date(entry.created_at).toLocaleDateString('ru-RU')}</Text>
            </View>
          ))}
        </View>

        <AttachmentsSection entityType="contact" entityId={id as string} />
      </ScrollView>
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, paddingBottom: 32 },
  card: { backgroundColor: c.bgPanel, borderRadius: 12, padding: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: c.amber, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionAddBtn: { fontSize: 13, fontWeight: '600', color: c.orange },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: c.orange, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarText: { color: '#FFFFFF', fontSize: 22, fontWeight: '700' },
  contactName: { fontSize: 20, fontWeight: '700', color: c.text1, marginBottom: 4 },
  secondaryText: { fontSize: 14, color: c.amber, marginBottom: 6 },
  statusBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, marginTop: 4 },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  detailRows: { marginTop: 14, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12 },
  detailRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  detailLabel: { fontSize: 13, color: c.textMuted, width: 64 },
  detailValue: { fontSize: 13, color: c.text1, flex: 1 },
  conversationButton: {
    marginTop: 14,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: c.orange,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  conversationButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  // AI summary. Same card as every other section; the primary button deliberately
  // matches conversationButton so the screen keeps one primary-action shape.
  aiCard: { gap: 10 },
  aiLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  aiHint: { fontSize: 13, color: c.amber, lineHeight: 19 },
  aiSummaryText: { fontSize: 15, color: c.text1, lineHeight: 22 },
  aiNextAction: { borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10, gap: 4 },
  aiNextActionLabel: { fontSize: 11, fontWeight: '700', color: c.amber, textTransform: 'uppercase', letterSpacing: 0.5 },
  aiNextActionText: { fontSize: 14, fontWeight: '500', color: c.text1, lineHeight: 20 },
  aiNote: { fontSize: 11, color: c.textMuted, lineHeight: 16 },
  aiButton: {
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: c.orange,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  aiButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  aiSecondaryButton: {
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiSecondaryButtonText: { color: c.orange, fontSize: 14, fontWeight: '600' },
  activitySummary: { fontSize: 14, color: c.text1, marginBottom: 2 },
  activityDate: { fontSize: 12, color: c.textMuted },
  dealTitle: { fontSize: 15, fontWeight: '600', color: c.text1, marginBottom: 8 },
  stageBadge: { backgroundColor: c.orange, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  stageBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  dealValue: { fontSize: 13, color: c.amber },
  taskTitle: { fontSize: 15, fontWeight: '500', color: c.text1, marginBottom: 8 },
  taskBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  taskDueDate: { fontSize: 12, color: c.amber },
  overdueText: { color: c.red, fontWeight: '500' },
  errorText: { fontSize: 14, color: c.red, marginBottom: 8 },
  retryButton: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.orange, borderRadius: 6 },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  emptyText: { fontSize: 14, color: c.textMuted, textAlign: 'center', paddingVertical: 8 },
  headerEditButton: { paddingHorizontal: 8, paddingVertical: 4 },
  headerEditText: { color: c.orange, fontSize: 16, fontWeight: '600' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  addLink: { color: c.orange, fontSize: 14, fontWeight: '600' },
  auditRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  auditBadge: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
  auditBadgeText: { fontSize: 12, fontWeight: '600' },
  auditDate: { fontSize: 12, color: c.textMuted },
});
