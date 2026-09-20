import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

vi.mock('axios');

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  access: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => fsMocks);
vi.mock('../core/mac-address.js', () => ({ getMacAddress: () => '00:11:22:33:44:55' }));

const mockedAxios = vi.mocked(axios);

async function loadModule() {
  vi.resetModules();
  return import('../core/auto-register.js');
}

function savedNode() {
  fsMocks.readFile.mockResolvedValue(JSON.stringify({
    nodeId: 'opencode_node1',
    nodeName: '构建机',
    token: 'expired-token',
    macAddress: '00:11:22:33:44:55',
  }));
}

describe('opencode token refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedNode();
  });

  it('rotates the node token through the refresh endpoint', async () => {
    const { refreshNodeToken } = await loadModule();
    mockedAxios.post = vi.fn().mockResolvedValue({ data: { code: 200, data: { token: 'rotated' } } });

    await expect(refreshNodeToken('https://example.test', 'opencode_node1', '构建机'))
      .resolves.toBe('rotated');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.test/api/claw/refresh-token/opencode_node1',
      { name: '构建机' },
      expect.any(Object),
    );
  });

  it('reports a device-credential node instead of retrying the refresh endpoint', async () => {
    const { refreshNodeToken, DeviceCredentialRequiredError } = await loadModule();
    mockedAxios.post = vi.fn().mockRejectedValue({
      response: { status: 409, data: { code: 409, error: 'device_credential_required' } },
    });

    await expect(refreshNodeToken('https://example.test', 'opencode_node1'))
      .rejects.toBeInstanceOf(DeviceCredentialRequiredError);
  });

  it('persists the rotated token for the saved node', async () => {
    const { refreshRegisteredToken } = await loadModule();
    mockedAxios.post = vi.fn().mockResolvedValue({ data: { code: 200, data: { token: 'rotated' } } });

    await expect(refreshRegisteredToken('https://example.test')).resolves.toBe('rotated');

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      expect.stringContaining('"token": "rotated"'),
    );
  });

  it('stops refreshing once the node reports it needs a device credential', async () => {
    const { refreshRegisteredToken } = await loadModule();
    mockedAxios.post = vi.fn().mockRejectedValue({
      response: { status: 409, data: { code: 409, error: 'device_credential_required' } },
    });

    await expect(refreshRegisteredToken('https://example.test')).resolves.toBe('');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    await expect(refreshRegisteredToken('https://example.test')).resolves.toBe('');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});
