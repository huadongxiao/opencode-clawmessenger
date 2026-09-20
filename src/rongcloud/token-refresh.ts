import { AUTHENTICATION_ERROR_CODES } from './auth-codes.js';
import type { RongCloudClient } from './client.js';
import type { RongCloudMessage } from '../core/types.js';

export interface ConnectOutcome {
  success: boolean;
  userId?: string;
  code?: number;
  /** 是否用换发后的 Token 重试过。 */
  refreshed: boolean;
}

/**
 * 连接融云；仅当失败原因是鉴权错误码时换发 Token 并重试一次。
 *
 * 融云 Token 可能配置了有效期（例如 1 天）。到期后 connect 会返回
 * 1002/31004/31020/31029，此时必须换发 Token 而不是重新注册节点。
 */
export async function connectWithTokenRefresh(
  client: RongCloudClient,
  handler: (msg: RongCloudMessage) => void,
  refreshToken: () => Promise<string>,
): Promise<ConnectOutcome> {
  const first = await client.connect(handler);
  if (first.success) return { ...first, refreshed: false };
  if (first.code === undefined || !AUTHENTICATION_ERROR_CODES.has(first.code)) {
    return { ...first, refreshed: false };
  }

  let fresh = '';
  try {
    fresh = await refreshToken();
  } catch {
    fresh = '';
  }
  if (!fresh) return { ...first, refreshed: false };

  client.setToken(fresh);
  const retried = await client.connect(handler);
  return { ...retried, refreshed: true };
}
