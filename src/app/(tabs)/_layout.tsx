import { Alert, TouchableOpacity } from 'react-native';
import { Tabs, router } from 'expo-router';
import { CalendarDays, Kanban, LayoutDashboard, Users, CheckSquare, Plus, MoreVertical, Settings } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';

const TEAL = '#C45A10';
const INACTIVE = '#CFADA3';

export default function TabsLayout() {
  const { t } = useTranslation();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: TEAL,
        tabBarInactiveTintColor: INACTIVE,
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopColor: '#FAF6F3',
          borderTopWidth: 1,
        },
        headerShown: true,
        headerTintColor: TEAL,
        headerStyle: { backgroundColor: '#ffffff' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.dashboard'),
          tabBarLabel: t('tabs.dashboard'),
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
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <Users color={color} size={size} />
          ),
          headerRight: (): JSX.Element => (
            <TouchableOpacity
              onPress={() => {
                Alert.alert(t('contacts.add'), undefined, [
                  { text: t('contacts.new'), onPress: () => { router.push('/contact/new'); } },
                  { text: t('contacts.scanCard'), onPress: () => { router.push('/contact/scan-card'); } },
                  { text: t('contacts.importPhone'), onPress: () => { router.push('/contact/import-phone'); } },
                  { text: t('contacts.importCsv'), onPress: () => { router.push('/contact/import-csv'); } },
                  { text: t('common.cancel'), style: 'cancel' },
                ]);
              }}
              style={{ marginRight: 16, padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel={t('contacts.add')}
            >
              <MoreVertical size={24} color={TEAL} />
            </TouchableOpacity>
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
        name="calendar"
        options={{
          title: t('tabs.calendar'),
          tabBarLabel: t('tabs.calendar'),
          tabBarIcon: ({ color, size }: { color: string | import('react-native').ColorValue; size: number }): JSX.Element => (
            <CalendarDays color={color} size={size} />
          ),
          headerRight: (): JSX.Element => (
            <TouchableOpacity
              onPress={() => { router.push('/calendar/new'); }}
              style={{ marginRight: 16, padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel={t('calendar.newEvent')}
            >
              <Plus size={24} color={TEAL} />
            </TouchableOpacity>
          ),
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
    </Tabs>
  );
}
