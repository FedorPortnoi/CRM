import { Tabs } from 'expo-router';
import { Kanban } from 'lucide-react-native';

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
        name="kanban"
        options={{
          title: 'Pipeline',
          tabBarLabel: 'Pipeline',
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <Kanban color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
