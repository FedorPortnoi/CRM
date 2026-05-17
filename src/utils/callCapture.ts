import { AppState, AppStateStatus, Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from './api';
import { notifyUnknownCallCapture } from './notifications';

const LAST_CALL_CHECK_KEY = 'crm_last_call_check';

type ContactMatch = {
  id: string;
  first_name: string;
  phone: string | null;
};

type ContactSearchResponse = {
  data: ContactMatch[];
};

type LogCallBody = {
  contact_id: string;
  direction: 'inbound' | 'outbound';
  duration_seconds?: number;
  occurred_at: string;
};

type CreateCaptureBody = {
  type: 'call';
  raw_data: Record<string, unknown>;
  phone_number: string;
};

async function findContactByPhone(phone: string, token: string): Promise<ContactMatch | null> {
  try {
    const url = `${API_URL}/contacts?phone=${encodeURIComponent(phone)}&per_page=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as ContactSearchResponse;
    return body.data[0] ?? null;
  } catch {
    return null;
  }
}

async function logCallForContact(
  contactId: string,
  direction: 'inbound' | 'outbound',
  token: string,
  occurredAt: string,
): Promise<void> {
  await fetch(`${API_URL}/messages/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      contact_id: contactId,
      direction,
      occurred_at: occurredAt,
    } satisfies LogCallBody),
  });
}

async function createCapture(
  phone: string,
  direction: 'inbound' | 'outbound',
  token: string,
  occurredAt: string,
): Promise<boolean> {
  const body: CreateCaptureBody = {
    type: 'call',
    raw_data: { phone, direction, timestamp: occurredAt },
    phone_number: phone,
  };

  try {
    const response = await fetch(`${API_URL}/captures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    return response.ok;
  } catch {
    return false;
  }
}

export function initCallCapture(getToken: () => string | null): () => void {
  // iOS limitation: without Apple VoIP entitlement, iOS can only
  // capture calls initiated through in-app tel: links.
  // This implementation supports:
  //   Android: Linking event fires when user taps a tel: link from within the app
  //   iOS: Same Linking event, but only for calls initiated via tel: links in-app

  const handleUrl = ({ url }: { url: string }): void => {
    if (!url.startsWith('tel:')) return;
    const phone = decodeURIComponent(url.slice(4));
    const token = getToken();
    if (!token || !phone) return;

    const occurredAt = new Date().toISOString();

    void (async () => {
      try {
        const contact = await findContactByPhone(phone, token);
        if (contact) {
          await logCallForContact(contact.id, 'outbound', token, occurredAt);
          return;
        }

        const captureCreated = await createCapture(phone, 'outbound', token, occurredAt);
        if (captureCreated) {
          await notifyUnknownCallCapture(phone);
        }
      } catch {
        // Call capture should never interrupt the user's outbound call flow.
      }
    })();
  };

  // Android foreground call log check (AppState-based polling)
  // When app comes to foreground, check if a call occurred recently
  const handleAppStateChange = (nextState: AppStateStatus): void => {
    if (nextState !== 'active') return;
    if (Platform.OS !== 'android') return;

    const token = getToken();
    if (!token) return;

    void (async () => {
      const lastCheckStr = await AsyncStorage.getItem(LAST_CALL_CHECK_KEY);
      const lastCheck = lastCheckStr ? new Date(lastCheckStr) : null;
      await AsyncStorage.setItem(LAST_CALL_CHECK_KEY, new Date().toISOString());

      // expo-call-log is not available in this managed Expo setup.
      // AppState foreground only tells us the app is active; we cannot
      // read the system call log without native permissions/modules.
      // Outgoing call logging is handled by the Linking listener above.
      // True Android inbound/background call-log capture requires native
      // android.permission.READ_CALL_LOG access and a native build.
      void lastCheck; // referenced to avoid unused-variable lint
    })();
  };

  const linkingSubscription = Linking.addEventListener('url', handleUrl);
  const appStateSubscription = AppState.addEventListener('change', handleAppStateChange);

  // Return cleanup function
  return () => {
    linkingSubscription.remove();
    appStateSubscription.remove();
  };
}
