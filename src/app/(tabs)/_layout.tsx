import { Tabs } from 'expo-router';
import { Kanban, LayoutDashboard, Users, CheckSquare } from 'lucide-react-native';

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
        }}
      />
    </Tabs>
  );
}
