import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type ActivityItem = {
  type: string;
  id: string;
  summary: string;
  created_at: string;
};

type DashboardData = {
  open_deals: { count: number; total_value: number };
  tasks_due_today: number;
  recent_activity: ActivityItem[];
  pipeline_health_score: number;
};

export default function DashboardScreen(): JSX.Element {
  const token = useUserStore((s) => s.token);
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchDashboard = useCallback(async (): Promise<void> => {
    if (!token) return;
    try {
      setError(null);
      const res = await fetch(`${API_URL}/analytics/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const json = (await res.json()) as { data: DashboardData };
      setData(json.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  const onRefresh = useCallback((): void => {
    setRefreshing(true);
    void fetchDashboard();
  }, [fetchDashboard]);

  const handleRetry = useCallback((): void => {
    setIsLoading(true);
    void fetchDashboard();
  }, [fetchDashboard]);

  if (isLoading) {
    return (
      <View style={styles.skeletonContainer}>
        <View style={[styles.skeletonCard, { marginTop: 16 }]} />
        <View style={styles.skeletonCard} />
        <View style={styles.skeletonCard} />
        <View style={styles.skeletonActivity} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!data) return <View style={styles.container} />;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.pageTitle}>Dashboard</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Open Deals</Text>
        <Text style={styles.cardValue}>{data.open_deals.count}</Text>
        <Text style={styles.cardSub}>
          ${data.open_deals.total_value.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Tasks Due Today</Text>
        <Text style={styles.cardValue}>{data.tasks_due_today}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Pipeline Health Score</Text>
        <Text style={styles.cardValue}>{data.pipeline_health_score.toFixed(2)}%</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent Activity</Text>
        {data.recent_activity.length === 0 ? (
          <Text style={styles.emptyText}>No recent activity</Text>
        ) : (
          data.recent_activity.map((item) => (
            <View key={item.id} style={styles.activityItem}>
              <Text style={styles.activityType}>{item.type.toUpperCase()}</Text>
              <Text style={styles.activitySummary} numberOfLines={2}>
                {item.summary}
              </Text>
              <Text style={styles.activityTime}>
                {new Date(item.created_at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  contentContainer: {
    paddingBottom: 24,
  },
  skeletonContainer: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    padding: 12,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#F5F5F5',
  },
  errorText: {
    color: '#D93025',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#1A73E8',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1A1A1A',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  card: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginTop: 12,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  cardLabel: {
    fontSize: 13,
    color: '#6B6B6B',
    fontWeight: '500',
    marginBottom: 4,
  },
  cardValue: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1A1A1A',
  },
  cardSub: {
    fontSize: 14,
    color: '#6B6B6B',
    marginTop: 2,
  },
  section: {
    marginHorizontal: 12,
    marginTop: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
    marginBottom: 10,
  },
  emptyText: {
    color: '#9B9B9B',
    fontSize: 14,
  },
  activityItem: {
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  activityType: {
    fontSize: 10,
    fontWeight: '700',
    color: '#1A73E8',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  activitySummary: {
    fontSize: 14,
    color: '#1A1A1A',
    marginBottom: 2,
  },
  activityTime: {
    fontSize: 11,
    color: '#9B9B9B',
  },
  skeletonCard: {
    height: 88,
    backgroundColor: '#E8E8E8',
    marginBottom: 12,
    borderRadius: 12,
  },
  skeletonActivity: {
    height: 200,
    backgroundColor: '#E8E8E8',
    borderRadius: 12,
  },
});
