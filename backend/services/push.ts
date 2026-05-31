import path from 'path';
import fs from 'fs';
import { GoogleAuth } from 'google-auth-library';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';

const expo = new Expo();

const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID ?? '';
const SERVICE_ACCOUNT_PATH = path.resolve(
  process.cwd(),
  process.env.FCM_SERVICE_ACCOUNT_PATH ?? 'firebase-service-account.json',
);

let _googleAuth: GoogleAuth | null = null;

function getGoogleAuth(): GoogleAuth {
  if (!_googleAuth) {
    if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
      throw new Error(`FCM service account file not found: ${SERVICE_ACCOUNT_PATH}`);
    }
    _googleAuth = new GoogleAuth({
      keyFile: SERVICE_ACCOUNT_PATH,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
  }
  return _googleAuth;
}

async function sendFcm(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  if (!FCM_PROJECT_ID) throw new Error('FCM_PROJECT_ID is not set');

  const auth = getGoogleAuth();
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          ...(data ? { data } : {}),
          android: { priority: 'high' },
        },
      }),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`FCM send failed: ${JSON.stringify(err)}`);
  }
}

async function sendExpo(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  const message: ExpoPushMessage = {
    to: token,
    sound: 'default',
    title,
    body,
    ...(data ? { data } : {}),
  };

  const [ticket] = await expo.sendPushNotificationsAsync([message]);

  if (ticket?.status === 'error') {
    throw Object.assign(new Error(ticket.message), { details: ticket.details });
  }
}

export type PushResult =
  | { ok: true }
  | { ok: false; code: 'DEVICE_NOT_REGISTERED' }
  | { ok: false; code: 'SEND_FAILED'; message: string };

export async function sendPush(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<PushResult> {
  try {
    if (Expo.isExpoPushToken(token)) {
      await sendExpo(token, title, body, data);
    } else {
      await sendFcm(token, title, body, data);
    }
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const details = (err as { details?: { error?: string } }).details;

    if (
      details?.error === 'DeviceNotRegistered' ||
      msg.includes('UNREGISTERED') ||
      msg.includes('NOT_FOUND')
    ) {
      return { ok: false, code: 'DEVICE_NOT_REGISTERED' };
    }

    return { ok: false, code: 'SEND_FAILED', message: msg };
  }
}
