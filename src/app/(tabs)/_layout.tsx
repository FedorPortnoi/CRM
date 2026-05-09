import { Alert, TouchableOpacity } from 'react-native';
import { Tabs, router } from 'expo-router';
import { Kanban, LayoutDashboard, Users, CheckSquare, Plus, MoreVertical } from 'lucide-react-native';

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
                  { text: 'Import from Phone', onPress: () => { router.push('/contact/import-phone'); } },
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
    </Tabs>
  );
}
