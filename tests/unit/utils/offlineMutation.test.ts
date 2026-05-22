import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  fetch: vi.fn(),
  netInfoFetch: vi.fn(),
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    fetch: mocks.netInfoFetch,
  },
}));

vi.mock('../../../src/utils/offlineQueue', () => ({
  enqueue: mocks.enqueue,
}));

import { sendOrQueueMutation } from '../../../src/utils/offlineMutation';

describe('sendOrQueueMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
  });

  it('queues mutations without calling fetch when disconnected', async () => {
    mocks.netInfoFetch.mockResolvedValue({
      isConnected: false,
      isInternetReachable: true,
    });

    const result = await sendOrQueueMutation({
      url: 'http://localhost:3000/api/v1/contacts',
      method: 'POST',
      token: 'token-1',
      body: { name: 'Ada Lovelace' },
    });

    expect(result).toEqual({ queued: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith({
      url: 'http://localhost:3000/api/v1/contacts',
      method: 'POST',
      body: JSON.stringify({ name: 'Ada Lovelace' }),
    });
  });

  it('queues mutations when the connection exists but internet reachability is false', async () => {
    mocks.netInfoFetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: false,
    });

    const result = await sendOrQueueMutation({
      url: 'http://localhost:3000/api/v1/tasks/123',
      method: 'PATCH',
      token: 'token-2',
    });

    expect(result).toEqual({ queued: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith({
      url: 'http://localhost:3000/api/v1/tasks/123',
      method: 'PATCH',
      body: '',
    });
  });

  it('sends mutations immediately when online and omits an empty body', async () => {
    const response = new Response(null, { status: 204 });
    mocks.netInfoFetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    });
    mocks.fetch.mockResolvedValue(response);

    const result = await sendOrQueueMutation({
      url: 'http://localhost:3000/api/v1/tasks/123/complete',
      method: 'POST',
      token: 'token-3',
    });

    expect(result).toEqual({ queued: false, response });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith('http://localhost:3000/api/v1/tasks/123/complete', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-3',
        'Content-Type': 'application/json',
      },
      body: undefined,
    });
  });

  it('sends serialized JSON when online with a body', async () => {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    mocks.netInfoFetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: null,
    });
    mocks.fetch.mockResolvedValue(response);

    const result = await sendOrQueueMutation({
      url: 'http://localhost:3000/api/v1/deals/123',
      method: 'PATCH',
      token: 'token-4',
      body: { value: 5000 },
    });

    expect(result).toEqual({ queued: false, response });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith('http://localhost:3000/api/v1/deals/123', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer token-4',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: 5000 }),
    });
  });

  it('queues mutations when an online fetch fails at the network layer', async () => {
    mocks.netInfoFetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    });
    mocks.fetch.mockRejectedValue(new TypeError('Network request failed'));

    const result = await sendOrQueueMutation({
      url: 'http://localhost:3000/api/v1/contacts',
      method: 'POST',
      token: 'token-5',
      body: { first_name: 'Grace' },
    });

    expect(result).toEqual({ queued: true });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      url: 'http://localhost:3000/api/v1/contacts',
      method: 'POST',
      body: JSON.stringify({ first_name: 'Grace' }),
    });
  });

  it('does not queue valid HTTP validation responses', async () => {
    const response = new Response(JSON.stringify({ error: { code: 'VALIDATION' } }), { status: 400 });
    mocks.netInfoFetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    });
    mocks.fetch.mockResolvedValue(response);

    const result = await sendOrQueueMutation({
      url: 'http://localhost:3000/api/v1/contacts',
      method: 'POST',
      token: 'token-6',
      body: { first_name: '' },
    });

    expect(result).toEqual({ queued: false, response });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
