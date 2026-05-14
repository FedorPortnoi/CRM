import { Alert, TouchableOpacity } from 'react-native';
import { Tabs, router } from 'expo-router';
import { CalendarDays, Kanban, LayoutDashboard, Users, CheckSquare, Plus, MoreVertical } from 'lucide-react-native';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#007AFF',
        tabBarInactiveTintColor: '#8E8E93',
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarLabel: 'Dashboard',
          tabBarIcon: ({ color, size }: { color: string; size: number }): JSX.Element => (
            <LayoutDashboard color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Contacts',
          tabBarLabel: 'Contacts',
          tabBarIcon: ({ color, size }: { color: string; size: number }): JSX.Element => (
            <Users color={color} size={size} />
          ),
          headerRight: (): JSX.Element => (
            <TouchableOpacity
              onPress={() => {
                Alert.alert('Add Contact', undefined, [
                  { text: 'New Contact', onPress: () => { router.push('/contact/new'); } },
                  { text: 'Scan Business Card', onPress: () => { router.push('/contact/scan-card'); } },
                  { text: 'Import from Phone', onPress: () => { router.push('/contact/import-phone'); } },
                  { text: 'Import CSV', onPress: () => { router.push('/contact/import-csv'); } },
                  { text: 'Cancel', style: 'cancel' },
                ]);
              }}
              style={{ marginRight: 16, padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel="Add contact options"
            >
              <MoreVertical size={24} color="#007AFF" />
            </TouchableOpacity>
          ),
        }}
      />
      <Tabs.Screen
        name="kanban"
        options={{
          title: 'Pipeline',
          tabBarLabel: 'Pipeline',
          tabBarIcon: ({ color, size }: { color: string; size: number }): JSX.Element => (
            <Kanban color={color} size={size} />
          ),
          headerRight: (): JSX.Element => (
            <TouchableOpacity
              onPress={() => { router.push('/deal/new'); }}
              style={{ marginRight: 16, padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel="New deal"
            >
              <Plus size={24} color="#007AFF" />
            </TouchableOpacity>
          ),
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: 'Tasks',
          tabBarLabel: 'Tasks',
          tabBarIcon: ({ color, size }: { color: string; size: number }): JSX.Element => (
            <CheckSquare color={color} size={size} />
          ),
          headerRight: (): JSX.Element => (
            <TouchableOpacity
              onPress={() => { router.push('/task/new'); }}
              style={{ marginRight: 16, padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel="New task"
            >
              <Plus size={24} color="#007AFF" />
            </TouchableOpacity>
          ),
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: 'Calendar',
          tabBarLabel: 'Calendar',
          tabBarIcon: ({ color, size }: { color: string; size: number }): JSX.Element => (
            <CalendarDays color={color} size={size} />
          ),
          headerRight: (): JSX.Element => (
            <TouchableOpacity
              onPress={() => { router.push('/calendar/new'); }}
              style={{ marginRight: 16, padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel="New calendar event"
            >
              <Plus size={24} color="#007AFF" />
            </TouchableOpacity>
          ),
        }}
      />
    </Tabs>
  );
}
