import { TouchableOpacity } from 'react-native';
import { Tabs, router } from 'expo-router';
import { MessageSquare, Kanban, LayoutDashboard, Users, CheckSquare, Plus, Settings, Bell } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../store/chatStore';
import { useNotificationStore } from '../../store/notificationStore';
import { useEffect } from 'react';
import NavHeader from '../../components/NavHeader';
import BottomTabBar from '../../components/BottomTabBar';

const TEAL = '#C45A10';

export default function TabsLayout() {
  const { t } = useTranslation();
  const totalUnread = useChatStore((s) => s.channels.reduce((sum, c) => sum + c.unread, 0));
  const notifUnread = useNotificationStore((s) => s.unreadCount);
  const fetchUnreadCount = useNotificationStore((s) => s.fetchUnreadCount);

  useEffect(() => {
    void fetchUnreadCount();
    const timer = setInterval(() => { void fetchUnreadCount(); }, 60_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Tabs
      tabBar={() => <BottomTabBar />}
      screenOptions={{
        headerShown: true,
        header: ({ options, route }) => (
          <NavHeader
            title={(options.title as string | undefined) ?? route.name}
            headerRight={options.headerRight}
          />
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.today'),
          tabBarLabel: t('tabs.today'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <LayoutDashboard color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: t('tabs.contacts'),
          tabBarLabel: t('tabs.contacts'),
          headerShown: false,
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <Users color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="kanban"
        options={{
          title: t('tabs.pipeline'),
          tabBarLabel: t('tabs.pipeline'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <Kanban color={color} size={size} />
          ),
          headerRight: (): JSX.Element => (
            <TouchableOpacity
              onPress={() => { router.push('/deal/new'); }}
              style={{ marginRight: 16, padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel={t('deals.add')}
            >
              <Plus size={24} color={TEAL} />
            </TouchableOpacity>
          ),
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: t('tabs.tasks'),
          tabBarLabel: t('tabs.tasks'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <CheckSquare color={color} size={size} />
          ),
          headerRight: (): JSX.Element => (
            <TouchableOpacity
              onPress={() => { router.push('/task/new'); }}
              style={{ marginRight: 16, padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel={t('tasks.add')}
            >
              <Plus size={24} color={TEAL} />
            </TouchableOpacity>
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: t('tabs.chat'),
          tabBarLabel: t('tabs.chat'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <MessageSquare color={color} size={size} />
          ),
          tabBarBadge: totalUnread > 0 ? (totalUnread > 99 ? '99+' : totalUnread) : undefined,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: t('tabs.notifications'),
          tabBarLabel: t('tabs.notifications'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <Bell color={color} size={size} />
          ),
          tabBarBadge: notifUnread > 0 ? (notifUnread > 99 ? '99+' : notifUnread) : undefined,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarLabel: t('tabs.settings'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <Settings color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{ title: t('tabs.calendar') }}
      />
    </Tabs>
  );
}
