import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listeners, connectMock } = vi.hoisted(() => ({
  listeners: new Map<string, (value: unknown) => void>(),
  connectMock: vi.fn(),
}));

vi.mock('../rongcloud/env-polyfill.js', () => ({}));
vi.mock('@rongcloud/imlib-next', () => ({
  init: vi.fn(),
  connect: connectMock,
  disconnect: vi.fn(),
  registerMessageType: vi.fn(() => class MockMessage {
    content: unknown;
    constructor(content: unknown) { this.content = content; }
  }),
  addEventListener: vi.fn((event: string, callback: (value: unknown) => void) => {
    listeners.set(event, callback);
  }),
  Events: {
    MESSAGES: 'MESSAGES',
    CONNECTED: 'CONNECTED',
    DISCONNECT: 'DISCONNECT',
    SUSPEND: 'SUSPEND',
  },
  ConversationType: { PRIVATE: 1, GROUP: 3, CHATROOM: 4 },
}));

import { AUTHENTICATION_ERROR_CODES, RongCloudClient } from '../rongcloud/client.js';

const log = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as never;

function createClient(token = 'expired-token') {
  return new RongCloudClient(
    { appKey: 'app-key', token, accountId: 'opencode_node1' },
    log,
  );
}

describe('rongcloud client token failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
  });

  it('treats the documented RongCloud codes as authentication failures', () => {
    expect([...AUTHENTICATION_ERROR_CODES].sort()).toEqual([1002, 31004, 31020, 31029]);
  });

  it('returns the failure code and remembers it when the token is rejected', async () => {
    connectMock.mockResolvedValue({ code: 31004 });
    const client = createClient();

    await expect(client.connect(vi.fn())).resolves.toEqual({ success: false, code: 31004 });

    expect(client.isConnected).toBe(false);
    expect(client.lastFailureCode).toBe(31004);
  });

  it('clears the failure code after a successful connection', async () => {
    connectMock.mockResolvedValue({ code: 0, data: { userId: 'opencode_node1' } });
    const client = createClient();

    await expect(client.connect(vi.fn())).resolves.toMatchObject({ success: true, userId: 'opencode_node1' });

    expect(client.isConnected).toBe(true);
    expect(client.lastFailureCode).toBeUndefined();
  });

  it('records an authentication code delivered by the disconnect event', async () => {
    connectMock.mockResolvedValue({ code: 0, data: { userId: 'opencode_node1' } });
    const client = createClient();
    await client.connect(vi.fn());

    listeners.get('DISCONNECT')?.(31004);

    expect(client.isConnected).toBe(false);
    expect(client.lastFailureCode).toBe(31004);
  });

  it('connects with the rotated token after setToken', async () => {
    connectMock.mockResolvedValue({ code: 0, data: { userId: 'opencode_node1' } });
    const client = createClient();
    client.setToken('fresh-token');

    await client.connect(vi.fn());

    expect(connectMock).toHaveBeenCalledWith('fresh-token');
  });
});
