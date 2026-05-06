import React, { useState, useCallback, useEffect } from 'react';
import { StyleSheet, ScrollView, View, Text, TouchableOpacity, RefreshControl } from 'react-native';
import { Stack, useLocalSearchParams, router } from 'expo-router';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

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

function formatValue(value: number | null): string {
  if (value === null) return 'No value';
  return '$' + value.toLocaleString('en-US');
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
  if (status === 'active') return '#34A853';
  if (status === 'inactive') return '#E8A000';
  return '#9B9B9B';
}

function taskBadgeColor(status: 'pending' | 'in_progress' | 'done' | 'cancelled'): string {
  if (status === 'done') return '#34A853';
  if (status === 'in_progress') return '#1A73E8';
  if (status === 'pending') return '#E8A000';
  return '#9B9B9B';
}

interface SkeletonBoxProps { width: number; height: number; borderRadius?: number; marginRight?: number; marginBottom?: number; }

function SkeletonBox({ width, height, borderRadius = 4, marginRight = 0, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return <View style={{ width, height, backgroundColor: '#E8E8E8', borderRadius, marginRight, marginBottom }} />;
}

export default function ContactDetailScreen(): JSX.Element {
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

  const fetchAll = useCallback(async (refreshing: boolean): Promise<void> => {
    if (refreshing) { setIsRefreshing(true); } else { setIsLoading(true); }
    await Promise.all([fetchContact(), fetchActivity(), fetchDeals(), fetchTasks()]);
    setIsLoading(false); setIsRefreshing(false);
  }, [fetchContact, fetchActivity, fetchDeals, fetchTasks]);

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
                    <Text style={styles.badgeText}>{contact.status}</Text>
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
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Activity</Text>
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
              <Text style={styles.emptyText}>No activity yet</Text>
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
          <Text style={styles.sectionTitle}>Deals</Text>
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
            <View style={styles.card}><Text style={styles.emptyText}>No deals yet</Text></View>
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
                  <Text style={styles.dealValue}>{formatValue(deal.value)}</Text>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Tasks</Text>
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
            <View style={styles.card}><Text style={styles.emptyText}>No tasks yet</Text></View>
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
                    <Text style={styles.badgeText}>{task.status.replace('_', ' ')}</Text>
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
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  content: { padding: 16, paddingBottom: 32 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 8, padding: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#6B6B6B', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#1A73E8', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarText: { color: '#FFFFFF', fontSize: 22, fontWeight: '700' },
  contactName: { fontSize: 20, fontWeight: '700', color: '#1A1A1A', marginBottom: 4 },
  secondaryText: { fontSize: 14, color: '#6B6B6B', marginBottom: 6 },
  statusBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, marginTop: 4 },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  detailRows: { marginTop: 14, borderTopWidth: 1, borderTopColor: '#F0F0F0', paddingTop: 12 },
  detailRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  detailLabel: { fontSize: 13, color: '#9B9B9B', width: 64 },
  detailValue: { fontSize: 13, color: '#1A1A1A', flex: 1 },
  activitySummary: { fontSize: 14, color: '#1A1A1A', marginBottom: 2 },
  activityDate: { fontSize: 12, color: '#9B9B9B' },
  dealTitle: { fontSize: 15, fontWeight: '600', color: '#1A1A1A', marginBottom: 8 },
  stageBadge: { backgroundColor: '#1A73E8', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  stageBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  dealValue: { fontSize: 13, color: '#6B6B6B' },
  taskTitle: { fontSize: 15, fontWeight: '500', color: '#1A1A1A', marginBottom: 8 },
  taskBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  taskDueDate: { fontSize: 12, color: '#6B6B6B' },
  overdueText: { color: '#D93025', fontWeight: '500' },
  errorText: { fontSize: 14, color: '#D93025', marginBottom: 8 },
  retryButton: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#1A73E8', borderRadius: 6 },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  emptyText: { fontSize: 14, color: '#9B9B9B', textAlign: 'center', paddingVertical: 8 },
  headerEditButton: { paddingHorizontal: 8, paddingVertical: 4 },
  headerEditText: { color: '#1A73E8', fontSize: 16, fontWeight: '600' },
});
