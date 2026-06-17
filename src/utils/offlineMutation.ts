import * as offlineQueue from './offlineQueue';

type MutationOptions = {
  url: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  token: string;
  body?: unknown;
};

type MutationResult =
  | { queued: true }
  | { queued: false; response: Response };

export async function sendOrQueueMutation(options: MutationOptions): Promise<MutationResult> {
  const serializedBody = options.body === undefined ? '' : JSON.stringify(options.body);

  const queueMutation = async (): Promise<MutationResult> => {
    await offlineQueue.enqueue({
      url: options.url,
      method: options.method,
      body: serializedBody,
    });
    return { queued: true };
  };

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
    };
    if (serializedBody) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(options.url, {
      method: options.method,
      headers,
      body: serializedBody || undefined,
    });

    return { queued: false, response };
  } catch {
    return queueMutation();
  }
}
