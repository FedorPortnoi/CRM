import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

export default function ContactDetailScreen(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Contact detail — coming soon</Text>
      <Text style={styles.sub}>{id}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  text: { fontSize: 16, color: '#1A1A1A' },
  sub: { fontSize: 12, color: '#9B9B9B', marginTop: 4 },
});
