import { Tabs } from 'expo-router';
import { Kanban, LayoutDashboard, Users, CheckSquare, MessageSquare, Bell, Settings } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '../../store/notificationStore';
import { useEffect } from 'react';
import NavHeader from '../../components/NavHeader';
import BottomTabBar from '../../components/BottomTabBar';

export default function TabsLayout() {
  const { t } = useTranslation();
  const fetchUnreadCount = useNotificationStore((s) => s.fetchUnreadCount);

  useEffect(() => {
    void fetchUnreadCount();
    const timer = setInterval(() => { void fetchUnreadCount(); }, 60_000);
    return () => clearInterval(timer);
  }, [fetchUnreadCount]);

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
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <LayoutDashboard color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: t('tabs.contacts'),
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
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <Kanban color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: t('tabs.tasks'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <CheckSquare color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: t('tabs.chat'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <MessageSquare color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: t('tabs.notifications'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <Bell color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
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
