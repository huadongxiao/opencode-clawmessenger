import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { createLogger } from '../core/logger.js';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

const log = createLogger('OpenCodeClient');

export class OpenCodeClient {
  private client: ReturnType<typeof createOpencodeClient>;
  private baseUrl: string;
  private directory: string;
  private systemPrompt?: string;

  constructor(options: { baseUrl: string; directory?: string; password?: string }) {
    this.baseUrl = options.baseUrl;
    this.directory = options.directory || process.cwd();
    
    const config: any = {
      baseUrl: this.baseUrl,
      directory: this.directory,
    };
    
    // 如果提供了密码，添加到请求头
    if (options.password) {
      config.headers = {
        'Authorization': `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`
      };
    }
    
    this.client = createOpencodeClient(config);
    
    // 加载 system prompt
    this.systemPrompt = this.loadSystemPrompt();
    log.info({ 
      hasSystemPrompt: !!this.systemPrompt, 
      systemPromptLength: this.systemPrompt?.length || 0,
      directory: this.directory 
    }, 'OpenCodeClient initialized');
  }

  private loadSystemPrompt(): string | undefined {
    // 1. 首先尝试加载 soul/ 目录下的魂器文件（和 hunqi 插件相同逻辑）
    const soulFiles = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md'];
    const soulParts: string[] = [];
    
    for (const filename of soulFiles) {
      const filepath = join(this.directory, 'soul', filename);
      if (existsSync(filepath)) {
        try {
          const content = readFileSync(filepath, 'utf-8');
          if (content.trim().length > 0) {
            soulParts.push(`=== ${filename} ===\n\n${content}`);
          }
        } catch (err) {
          log.warn({ err, filepath }, 'Failed to read soul file');
        }
      }
    }
    
    if (soulParts.length > 0) {
      const soulText = soulParts.join('\n\n---\n\n');
      log.info({ soulFilesLoaded: soulParts.length, totalLength: soulText.length }, 'Loaded soul framework files');
      return soulText;
    }
    
    // 2. 回退到 .opencode/prompt.md
    try {
      const promptPath = join(this.directory, '.opencode', 'prompt.md');
      log.info({ promptPath }, 'Looking for system prompt');
      if (existsSync(promptPath)) {
        const content = readFileSync(promptPath, 'utf-8');
        if (content.trim().length > 0) {
          log.info({ path: promptPath, length: content.length }, 'Loaded system prompt');
          return content;
        }
      } else {
        log.warn({ promptPath }, 'System prompt file not found');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load system prompt');
    }
    return undefined;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt;
  }

  async createSession(title: string): Promise<{ id: string }> {
    const { data, error } = await this.client.session.create({ title });
    if (error) {
      const errStr = typeof error === 'object' ? JSON.stringify(error) : String(error);
      throw new Error(`创建会话失败: ${errStr}`);
    }
    const sessionId = data?.id || (data as any)?.session_id;
    if (!sessionId) throw new Error('创建会话返回空 ID');
    log.info({ sessionId }, 'Session created');
    return { id: sessionId };
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const { data } = await this.client.session.get({ sessionID: sessionId });
      return !!data;
    } catch { return false; }
  }

  async sendPromptAsync(sessionId: string, text: string): Promise<void> {
    const { error } = await this.client.session.promptAsync({
      sessionID: sessionId,
      system: this.systemPrompt,
      parts: [{ type: 'text' as const, text: text }],
    });

    if (error) {
      const errStr = typeof error === 'object' ? JSON.stringify(error) : String(error);
      throw new Error(`发送消息失败: ${errStr}`);
    }

    log.info({ sessionId, hasSystemPrompt: !!this.systemPrompt }, 'promptAsync fired');
  }

  async sendPrompt(sessionId: string, text: string): Promise<string> {
    const { error } = await this.client.session.prompt({
      sessionID: sessionId,
      system: this.systemPrompt,
      parts: [{ type: 'text' as const, text: text }],
    });

    if (error) {
      const errStr = typeof error === 'object' ? JSON.stringify(error) : String(error);
      throw new Error(`发送消息失败: ${errStr}`);
    }

    log.info({ sessionId }, 'Prompt sent, waiting for response');
    return this.waitForResponse(sessionId);
  }

  async subscribeGlobalEvents(): Promise<{ stream: AsyncGenerator<any, void, unknown> }> {
    const result = await this.client.global.event({});
    log.info('Global SSE stream connected');
    return result;
  }

  private async waitForResponse(sessionId: string): Promise<string> {
    try {
      await this.client.v2.session.wait({ sessionID: sessionId });
      log.info({ sessionId }, 'Session completed');

      for (let i = 0; i < 30; i++) {
        const { data: messages } = await this.client.session.messages({ sessionID: sessionId });
        if (messages && Array.isArray(messages) && messages.length > 0) {
          const lastMsg = messages[messages.length - 1] as any;
          if (lastMsg.parts && lastMsg.parts.length > 0) {
            const textPart = lastMsg.parts.find((p: any) => p.type === 'text');
            if (textPart && textPart.text) {
              return textPart.text;
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return '回复已生成但无法读取内容';
    } catch (err: any) {
      log.error({ err, sessionId }, '等待会话完成失败');
      return '响应超时，请稍后重试';
    }
  }

  async fetchLastMessageText(sessionId: string): Promise<string | null> {
    try {
      const { data: messages } = await this.client.session.messages({ sessionID: sessionId });
      log.info({ messageCount: messages?.length }, 'Fetched messages');
      
      if (messages && Array.isArray(messages) && messages.length > 0) {
        // 从后往前找 AI 的回复
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as any;
          const role = msg.role || msg.author?.role;
          log.info({ index: i, role, info: msg.info, keys: Object.keys(msg).slice(0, 10), hasParts: !!msg.parts, partCount: msg.parts?.length }, 'Checking message');
          
          if (role === 'assistant' || role === 'model') {
            if (msg.parts && msg.parts.length > 0) {
              const textPart = msg.parts.find((p: any) => p.type === 'text');
              if (textPart?.text) {
                log.info({ textLength: textPart.text.length }, 'Found AI response');
                return textPart.text;
              }
            }
          }
        }
        
        // 如果没找到 assistant 消息，返回最后一条消息的文本（可能是不同格式）
        const lastMsg = messages[messages.length - 1] as any;
        if (lastMsg.parts && lastMsg.parts.length > 0) {
          const textPart = lastMsg.parts.find((p: any) => p.type === 'text');
          if (textPart?.text) {
            log.info({ role: lastMsg.role || lastMsg.author?.role, textLength: textPart.text.length }, 'Using last message as fallback');
            return textPart.text;
          }
        }
      }
    } catch (err: any) {
      log.error({ err: err.message }, 'Failed to fetch messages');
    }
    return null;
  }

  async sendCommand(sessionId: string, command: string): Promise<void> {
    try {
      await this.client.session.prompt({
        sessionID: sessionId,
        parts: [{ type: 'text' as const, text: command }],
      });
    } catch (err) {
      log.warn({ err, sessionId, command }, 'Command failed');
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.client.session.delete({ sessionID: sessionId });
      log.info({ sessionId }, 'Session deleted');
    } catch (err: any) {
      log.error({ err, sessionId }, '删除会话失败');
    }
  }

  async listSessions(): Promise<any[]> {
    try {
      const { data } = await this.client.session.list({});
      return (data as any) || [];
    } catch { return []; }
  }
}

export async function checkOpencodeStatus(opencodeUrl: string, password?: string): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (password) {
    headers['Authorization'] = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  }
  
  // 尝试多个端点，因为不同版本的 OpenCode 可能响应不同的路径
  const endpoints = [
    `${opencodeUrl}/health`,
    `${opencodeUrl}/api/health`,
    `${opencodeUrl}/v1/health`,
    opencodeUrl,  // 最后尝试根路径
  ];
  
  for (const url of endpoints) {
    try {
      log.debug({ url }, 'Trying OpenCode health endpoint');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (response.ok || response.status === 401) {
        log.info({ url, status: response.status }, 'OpenCode status check success');
        return true;
      }
    } catch (err: any) {
      log.debug({ url, err: err.message }, 'OpenCode endpoint check failed');
      // 继续尝试下一个端点
    }
  }
  
  log.warn({ opencodeUrl }, 'OpenCode status check failed on all endpoints');
  return false;
}