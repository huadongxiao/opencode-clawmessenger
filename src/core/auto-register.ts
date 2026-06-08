import axios from 'axios';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { readFile, access, writeFile, mkdir } from 'fs/promises';
import { getMacAddress } from './mac-address.js';
import type { Logger } from './logger.js';
import https from 'https';

const DEFAULT_SERVER_URL = 'https://newsradar.dreamdt.cn/im-test';
const TOKEN_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const CONFIG_DIR = path.join(os.homedir(), '.claw-bridge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function generateNodeId(): string {
  const mac = getMacAddress();
  const random = crypto.randomBytes(3).toString('hex');
  return `claw_${mac.replace(/:/g, '').substring(0, 6)}_${random}`;
}

export function getDeviceInfo() {
  return {
    deviceName: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    cpuCount: os.cpus().length,
    macAddress: getMacAddress(),
  };
}

export async function registerNode(
  serverUrl: string = DEFAULT_SERVER_URL,
  nodeName?: string,
  log?: Logger,
): Promise<{ nodeId: string; nodeName: string; token: string; success: boolean }> {
  const nodeId = generateNodeId();
  const nickname = nodeName || os.hostname();
  const macAddress = getMacAddress();

  log?.info(`注册节点: ${nodeId}, 昵称: ${nickname}`);

  try {
    const response = await axios.post(
      `${serverUrl}/api/claw/register`,
      { node_id: nodeId, name: nickname, mac_address: macAddress },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
    );

    if (response.data?.code === 200) {
      const token = response.data.data?.token || response.data.data?.rong_token || response.data.rong_token || '';
      const serverNodeId = response.data.data?.node_id || response.data.node_id || '';
      if (!token) {
        log?.error('注册接口未返回 token');
        return { nodeId, nodeName: nickname, token: '', success: false };
      }
      // 使用服务端返回的 node_id，而不是客户端生成的
      const actualNodeId = serverNodeId || nodeId;
      log?.info(`注册成功, 服务端nodeId: ${serverNodeId}, Token: ${token.substring(0, 20)}...`);
      await saveAutoConfig({ nodeId: actualNodeId, nodeName: nickname, token, macAddress });
      return { nodeId: actualNodeId, nodeName: nickname, token, success: true };
    }

    if (response.data?.code === 409) {
      log?.info('节点已存在，获取 Token...');
      const tokenResp = await axios.get(`${serverUrl}/api/claw/token/${nodeId}`, { timeout: 10000 });
      if (tokenResp.data?.code === 200) {
        const token = tokenResp.data.data?.token || tokenResp.data.token || '';
        if (!token) {
          log?.error('获取 token 接口未返回 token');
          return { nodeId, nodeName: nickname, token: '', success: false };
        }
        await saveAutoConfig({ nodeId, nodeName: nickname, token, macAddress });
        return { nodeId, nodeName: nickname, token, success: true };
      }
      log?.error(`获取 token 失败: ${tokenResp.data?.message || '未知错误'}`);
      return { nodeId, nodeName: nickname, token: '', success: false };
    }

    log?.error(`注册失败: code=${response.data?.code}, message=${response.data?.message}`);
    return { nodeId, nodeName: nickname, token: '', success: false };
  } catch (err: any) {
    log?.error(`注册异常: ${err.message}`);
    return { nodeId, nodeName: nickname, token: '', success: false };
  }
}

export async function getOrRegisterToken(
  serverUrl?: string,
  nodeName?: string,
  log?: Logger,
): Promise<string> {
  const existingConfig = await loadAutoConfig();
  if (existingConfig?.token) {
    const isExpired = existingConfig.expiresAt ? Date.now() > existingConfig.expiresAt : false;
    if (!isExpired) {
      log?.info(`使用已有 token, nodeId=${existingConfig.nodeId}`);
      return existingConfig.token;
    }
    log?.info('token 已过期，重新获取...');
  }

  const result = await registerNode(serverUrl, nodeName, log);
  if (result.success && result.token) return result.token;

  log?.error('获取 token 失败');
  return '';
}

async function saveAutoConfig(config: any): Promise<void> {
  try { await mkdir(CONFIG_DIR, { recursive: true }); } catch { }

  const data = {
    nodeId: config.nodeId,
    nodeName: config.nodeName,
    token: config.token,
    macAddress: config.macAddress,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + TOKEN_VALIDITY_MS,
  };

  await writeFile(CONFIG_FILE, JSON.stringify(data, null, 2));
}

export async function loadAutoConfig(): Promise<any> {
  try {
    await access(CONFIG_FILE);
    const content = await readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(content);
  } catch { return null; }
}

let cachedAppKey: string | undefined = undefined;

export async function getAppKey(serverUrl?: string): Promise<string> {
  // 如果已缓存，直接返回
  if (cachedAppKey) {
    return cachedAppKey;
  }
  
  // 从服务端获取 - 使用 /im-test 路径前缀
  const baseUrl = 'https://newsradar.dreamdt.cn/im-test';
  try {
    const response = await axios.get(`${baseUrl}/api/config/rongcloud`, { timeout: 10000 });
    if (response.data?.code === 200 && response.data.data?.appKey) {
      cachedAppKey = response.data.data.appKey as string;
      return cachedAppKey;
    }
  } catch (e) {
    console.warn('从服务端获取 AppKey 失败，使用默认值:', e);
  }
  
  // 兜底默认值
  return 'bmdehs6pbyyks';
}

let cachedAppSecret: string | undefined = undefined;

export async function getAppSecret(serverUrl: string, token: string, nodeId?: string): Promise<string | undefined> {
  // 如果已缓存，直接返回
  if (cachedAppSecret) {
    return cachedAppSecret;
  }
  
  // 从服务端获取 - 需要节点 token 验证
  const baseUrl = serverUrl.replace(/\/$/, '');
  try {
    const headers: Record<string, string> = {
      'X-Node-Token': token
    };
    // 如果提供了 nodeId，发送给服务端作为 fallback 验证
    if (nodeId) {
      headers['X-Node-Id'] = nodeId;
    }
    
    const response = await axios.get(`${baseUrl}/api/config/rongcloud/secret`, {
      timeout: 10000,
      headers,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false
      })
    });
    console.log('AppSecret response:', JSON.stringify(response.data, null, 2));
    if (response.data?.code === 200 && response.data.data?.appSecret) {
      cachedAppSecret = response.data.data.appSecret as string;
      return cachedAppSecret;
    }
  } catch (e: any) {
    console.warn('从服务端获取 AppSecret 失败:', e.message || e);
    if (e.response) {
      console.warn('Error response:', e.response.status, e.response.data);
    }
  }
  
  return undefined;
}

export function getServerUrl(): string {
  return process.env.DM_SERVER_URL || 'https://newsradar.dreamdt.cn/im-test';
}
