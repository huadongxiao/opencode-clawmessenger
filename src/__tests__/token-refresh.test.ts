import { describe, expect, it, vi } from 'vitest';
import { connectWithTokenRefresh } from '../rongcloud/token-refresh.js';
import type { RongCloudClient } from '../rongcloud/client.js';

type ConnectResult = { success: boolean; userId?: string; code?: number };

function fakeClient(results: ConnectResult[]) {
  const connect = vi.fn(async () => results.shift() ?? { success: false, code: 0 });
  const setToken = vi.fn();
  return {
    client: { connect, setToken } as unknown as RongCloudClient,
    connect,
    setToken,
  };
}

const handler = vi.fn();

describe('opencode rongcloud token refresh', () => {
  it('rotates the token and retries once when RongCloud rejects the stored one', async () => {
    const { client, connect, setToken } = fakeClient([
      { success: false, code: 31004 },
      { success: true, userId: 'opencode_node1' },
    ]);
    const refreshToken = vi.fn().mockResolvedValue('fresh-token');

    const outcome = await connectWithTokenRefresh(client, handler, refreshToken);

    expect(outcome).toMatchObject({ success: true, userId: 'opencode_node1', refreshed: true });
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(setToken).toHaveBeenCalledWith('fresh-token');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not rotate the token for a non-authentication failure', async () => {
    const { client, connect, setToken } = fakeClient([{ success: false, code: 30001 }]);
    const refreshToken = vi.fn().mockResolvedValue('fresh-token');

    const outcome = await connectWithTokenRefresh(client, handler, refreshToken);

    expect(outcome).toMatchObject({ success: false, code: 30001, refreshed: false });
    expect(refreshToken).not.toHaveBeenCalled();
    expect(setToken).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('keeps the original failure when the refresh returns no token', async () => {
    const { client, connect, setToken } = fakeClient([{ success: false, code: 31004 }]);
    const refreshToken = vi.fn().mockResolvedValue('');

    const outcome = await connectWithTokenRefresh(client, handler, refreshToken);

    expect(outcome).toMatchObject({ success: false, code: 31004, refreshed: false });
    expect(setToken).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('keeps the original failure when the refresh throws', async () => {
    const { client, connect, setToken } = fakeClient([{ success: false, code: 31004 }]);
    const refreshToken = vi.fn().mockRejectedValue(new Error('offline'));

    const outcome = await connectWithTokenRefresh(client, handler, refreshToken);

    expect(outcome).toMatchObject({ success: false, code: 31004, refreshed: false });
    expect(setToken).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('reports the retry failure when the rotated token is also rejected', async () => {
    const { client, connect, setToken } = fakeClient([
      { success: false, code: 31004 },
      { success: false, code: 31004 },
    ]);

    const outcome = await connectWithTokenRefresh(client, handler, vi.fn().mockResolvedValue('fresh-token'));

    expect(outcome).toMatchObject({ success: false, code: 31004, refreshed: true });
    expect(setToken).toHaveBeenCalledWith('fresh-token');
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
