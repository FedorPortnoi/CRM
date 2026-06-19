import { useState, useCallback, useEffect } from 'react';
import { StyleSheet, ScrollView, View, Text, TouchableOpacity, RefreshControl, Linking, Alert, ActionSheetIOS, Platform } from 'react-native';
import { Stack, useLocalSearchParams, router } from 'expo-router';
import { MessageCircle } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { formatMarketDate, formatMoney } from '../../market/profile';
import AttachmentsSection from '../../components/AttachmentsSection';

interface AuditEntry {
  id: string;
  user_id: string | null;
  action: string;
  created_at: string;
}

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
  return formatMoney(value, currency, { empty: 'No value' });
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

function statusBadgeColor(status: string): string {
  if (status === 'active') return '#C4704F';
  if (status === 'inactive') return '#E8A000';
  return '#CFADA3';
}

function taskBadgeColor(status: 'pending' | 'in_progress' | 'done' | 'cancelled'): string {
  if (status === 'done') return '#C4704F';
  if (status === 'in_progress') return '#C4704F';
  if (status === 'pending') return '#E8A000';
  return '#CFADA3';
}

interface SkeletonBoxProps { width: number; height: number; borderRadius?: number; marginRight?: number; marginBottom?: number; }

function SkeletonBox({ width, height, borderRadius = 4, marginRight = 0, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return <View style={{ width, height, backgroundColor: '#FEF0E8', borderRadius, marginRight, marginBottom }} />;
}

export default function ContactDetailScreen(): JSX.Element {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);
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
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);

  const fetchContact = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(API_URL + '/contacts/' + id, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) {
        const body = (await res.json()) as { error: { code: string; message: string } };
        setContactError(body.error.message); return;
      }
      const body = (await res.json()) as { data: Contact };
      setContact(body.data); setContactError(null);
    } catch { setContactError('Failed to load contact'); }
  }, [id, token]);

  const fetchActivity = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(API_URL + '/contacts/' + id + '/activity', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { setActivityError('Failed to load activity'); return; }
      const body = (await res.json()) as { data: ActivityData };
      setActivity(body.data); setActivityError(null);
    } catch { setActivityError('Failed to load activity'); }
  }, [id, token]);

  const fetchDeals = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(API_URL + '/contacts/' + id + '/deals', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { setDealsError('Failed to load deals'); return; }
      const body = (await res.json()) as { data: Deal[] };
      setDeals(body.data); setDealsError(null);
    } catch { setDealsError('Failed to load deals'); }
  }, [id, token]);

  const fetchTasks = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(API_URL + '/contacts/' + id + '/tasks', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { setTasksError('Failed to load tasks'); return; }
      const body = (await res.json()) as { data: Task[] };
      setTasks(body.data); setTasksError(null);
    } catch { setTasksError('Failed to load tasks'); }
  }, [id, token]);

  const fetchAuditLog = useCallback(async (): Promise<void> => {
    if (!token || !id) return;
    try {
      const res = await fetch(`${API_URL}/activities?entity_type=contact&entity_id=${id}`, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return;
      const body = (await res.json()) as { data: AuditEntry[] };
      setAuditLog(body.data);
    } catch { /* silent */ }
  }, [id, token]);


  const fetchAll = useCallback(async (refreshing: boolean): Promise<void> => {
    if (refreshing) { setIsRefreshing(true); } else { setIsLoading(true); }
    await Promise.all([fetchContact(), fetchActivity(), fetchDeals(), fetchTasks(), fetchAuditLog()]);
    setIsLoading(false); setIsRefreshing(false);
  }, [fetchContact, fetchActivity, fetchDeals, fetchTasks, fetchAuditLog]);

  useEffect(() => { fetchAll(false); }, [fetchAll]);
  const onRefresh = useCallback((): void => { fetchAll(true); }, [fetchAll]);
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
                <Text style={styles.headerEditText}>Edit</Text>
              </TouchableOpacity>
            ) : null
          ),
        }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}
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
              <TouchableOpacity style={styles.retryButton} onPress={fetchContact}>
                <Text style={styles.retryText}>Retry</Text>
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
                  <View style={[styles.statusBadge, { backgroundColor: statusBadgeColor(contact.status) }]}>
                    <Text style={styles.badgeText}>{contact.status === 'active' ? t('contacts.statusActive') : contact.status === 'inactive' ? t('contacts.statusInactive') : contact.status}</Text>
                  </View>
                </View>
              </View>
              {(contact.phone || contact.mobile || contact.email) ? (
                <View style={styles.detailRows}>
                  {contact.phone ? (
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Phone</Text>
                      <Text style={styles.detailValue}>{contact.phone}</Text>
                    </View>
                  ) : null}
                  {contact.mobile ? (
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Mobile</Text>
                      <Text style={styles.detailValue}>{contact.mobile}</Text>
                    </View>
                  ) : null}
                  {contact.email ? (
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Email</Text>
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
                <TouchableOpacity style={styles.retryButton} onPress={fetchActivity}>
                  <Text style={styles.retryText}>Retry</Text>
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
              <TouchableOpacity style={styles.retryButton} onPress={fetchDeals}>
                <Text style={styles.retryText}>Retry</Text>
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
              <TouchableOpacity style={styles.retryButton} onPress={fetchTasks}>
                <Text style={styles.retryText}>Retry</Text>
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
                  <View style={[styles.taskBadge, { backgroundColor: taskBadgeColor(task.status) }]}>
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
              <View style={[styles.auditBadge, { backgroundColor: entry.action === 'created' ? '#FEF0E8' : entry.action === 'updated' ? '#dbeafe' : '#FAF6F3' }]}>
                <Text style={[styles.auditBadgeText, { color: entry.action === 'created' ? '#C45A10' : entry.action === 'updated' ? '#1d4ed8' : '#383432' }]}>{entry.action === 'created' ? t('contacts.actionCreated') : entry.action === 'updated' ? t('contacts.actionUpdated') : entry.action}</Text>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FEF0E8' },
  content: { padding: 16, paddingBottom: 32 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#B07868', textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionAddBtn: { fontSize: 13, fontWeight: '600', color: '#C45A10' },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#C4704F', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarText: { color: '#FFFFFF', fontSize: 22, fontWeight: '700' },
  contactName: { fontSize: 20, fontWeight: '700', color: '#383432', marginBottom: 4 },
  secondaryText: { fontSize: 14, color: '#B07868', marginBottom: 6 },
  statusBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, marginTop: 4 },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  detailRows: { marginTop: 14, borderTopWidth: 1, borderTopColor: '#F0F0F0', paddingTop: 12 },
  detailRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  detailLabel: { fontSize: 13, color: '#CFADA3', width: 64 },
  detailValue: { fontSize: 13, color: '#383432', flex: 1 },
  conversationButton: {
    marginTop: 14,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: '#C4704F',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  conversationButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  activitySummary: { fontSize: 14, color: '#383432', marginBottom: 2 },
  activityDate: { fontSize: 12, color: '#CFADA3' },
  dealTitle: { fontSize: 15, fontWeight: '600', color: '#383432', marginBottom: 8 },
  stageBadge: { backgroundColor: '#C4704F', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  stageBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  dealValue: { fontSize: 13, color: '#B07868' },
  taskTitle: { fontSize: 15, fontWeight: '500', color: '#383432', marginBottom: 8 },
  taskBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  taskDueDate: { fontSize: 12, color: '#B07868' },
  overdueText: { color: '#ef4444', fontWeight: '500' },
  errorText: { fontSize: 14, color: '#ef4444', marginBottom: 8 },
  retryButton: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#C4704F', borderRadius: 6 },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  emptyText: { fontSize: 14, color: '#CFADA3', textAlign: 'center', paddingVertical: 8 },
  headerEditButton: { paddingHorizontal: 8, paddingVertical: 4 },
  headerEditText: { color: '#C4704F', fontSize: 16, fontWeight: '600' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  addLink: { color: '#C45A10', fontSize: 14, fontWeight: '600' },
  auditRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  auditBadge: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
  auditBadgeText: { fontSize: 12, fontWeight: '600' },
  auditDate: { fontSize: 12, color: '#CFADA3' },
});
