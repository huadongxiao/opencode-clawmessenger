import { createLogger } from '../core/logger.js';
import type { RongCloudClient } from '../rongcloud/client.js';
import type { SessionManager } from '../core/session-manager.js';
import type { OpenCodeClient } from './client.js';
import { RongCloudServerAPI } from '../rongcloud/server-api.js';
import type { ClawMessengerConfig } from '../core/types.js';

const log = createLogger('EventHandler');

interface StreamState {
  messageUID: string;
  seq: number;
  lastContent: string;
  lastSentTime: number;
  fullContent: string;  // 累积的完整内容
  hasSentStream: boolean;  // 是否已发送过流式片段
  chatId: string;
  targetId: string;
  isGroup: boolean;
}

export class EventHandler {
  private sessionManager: SessionManager;
  private rongClient: RongCloudClient;
  private opencode: OpenCodeClient;
  private streamAPI: RongCloudServerAPI;
  private config: ClawMessengerConfig;
  private isRunning = false;
  private sentSessions = new Set<string>();
  private streamStates = new Map<string, StreamState>();
  private streamQueue = Promise.resolve();  // 流式消息串行队列

  constructor(
    sessionManager: SessionManager,
    rongClient: RongCloudClient,
    opencode: OpenCodeClient,
    config: ClawMessengerConfig,
  ) {
    this.sessionManager = sessionManager;
    this.rongClient = rongClient;
    this.opencode = opencode;
    this.config = config;
    this.streamAPI = new RongCloudServerAPI(config.appKey, config.appSecret || '');
  }

  async start(eventStream: { stream: AsyncGenerator<any, void, unknown> }): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    log.info('Event handler started');

    try {
      for await (const event of eventStream.stream) {
        if (!this.isRunning) break;
        await this.handleEvent(event);
      }
    } catch (err) {
      log.error({ err }, 'SSE stream error');
    } finally {
      this.isRunning = false;
    }
  }

  stop(): void {
    this.isRunning = false;
  }

  private async handleEvent(globalEvent: any): Promise<void> {
    try {
      const payload = globalEvent.payload || globalEvent;
      const props = payload.properties || payload;

      log.info({ type: payload.type, hasProperties: !!payload.properties }, 'SSE event received');

      switch (payload.type) {
        case 'session.idle':
          log.info({ sessionId: props.sessionID }, 'Session idle event');
          await this.handleSessionIdle(props);
          break;
        case 'message.part.delta':
          // 细粒度 token 级流式增量
          await this.handleMessagePartDelta(props);
          break;
        case 'message.part.updated':
          log.info({ sessionId: props.sessionID }, 'Message part updated event');
          await this.handleMessagePartUpdated(props);
          break;
        case 'message.updated':
          log.info({ sessionId: props.sessionID, messageKeys: Object.keys(props.message || {}) }, 'Message updated event');
          await this.handleMessageUpdated(props);
          break;
        case 'session.status':
          this.handleStatusChange(props);
          break;
        case 'session.error':
          await this.handleError(props);
          break;
        default:
          log.debug({ type: payload.type }, 'Unhandled event type');
      }
    } catch (err) {
      log.error({ err }, 'Error handling event');
    }
  }

  /**
   * 处理 message.part.delta 事件（细粒度 token 级流式增量）
   * 从事件中直接提取增量文本，无需调用 fetchLastMessageText
   */
  private async handleMessagePartDelta(properties: { sessionID: string; part?: any; delta?: string; text?: string }): Promise<void> {
    const sessionId = properties.sessionID;
    log.info({ sessionId, hasDelta: !!properties.delta, hasText: !!properties.text, hasPart: !!properties.part }, 'handleMessagePartDelta called');

    // 需要 appSecret 才能调用融云服务端 API 发送流式消息
    if (!this.config.appSecret) {
      log.warn({ sessionId }, 'Streaming skipped: appSecret not configured');
      return;
    }

    // 如果已经发送过完整回复，跳过
    if (this.sentSessions.has(sessionId)) {
      log.warn({ sessionId }, 'Session already sent, skipping stream delta');
      return;
    }

    // 从事件中提取增量文本（兼容多种可能的结构）
    const delta = properties.delta || properties.text || properties.part?.delta || properties.part?.text || '';
    if (typeof delta !== 'string') {
      return;
    }
    // 注意：空字符串的 delta 是合法的（无新内容块），不跳过，继续执行以维持流状态

    // 初始化流式状态
    let streamState = this.streamStates.get(sessionId);
    if (!streamState) {
      const chatId = this.sessionManager.getChatIdBySession(sessionId);
      if (!chatId) {
        log.warn({ sessionId }, 'No chatId found for message.part.delta');
        return;
      }

      streamState = {
        messageUID: '',
        seq: 1,  // 融云要求 seq 从 1 开始
        lastContent: '',
        lastSentTime: Date.now(),
        fullContent: '',
        hasSentStream: false,
        chatId,
        targetId: chatId.replace('claw-', ''),
        isGroup: chatId.startsWith('group_'),
      };
      this.streamStates.set(sessionId, streamState);
    }

    // 累积完整内容
    streamState.fullContent += delta;

    log.info({ sessionId, seq: streamState.seq, deltaLength: delta.length }, 'Sending stream delta');

    // 使用队列确保流式消息片段串行发送
    this.streamQueue = this.streamQueue.then(async () => {
      try {
        const isFirstChunk = streamState!.seq === 1;

        log.info({ sessionId, seq: streamState!.seq, isFirstChunk, targetId: streamState!.targetId, deltaLength: delta.length }, 'Sending stream chunk to RongCloud');

        if (streamState!.isGroup) {
          const result = await this.streamAPI.sendStreamGroup({
            fromUserId: this.config.accountId,
            toGroupId: streamState!.targetId,
            content: delta,
            isFirstChunk,
            isLastChunk: false,
            seq: streamState!.seq,
            messageUID: streamState!.messageUID || null,
          });
          if (result.messageUID) streamState!.messageUID = result.messageUID;
        } else {
          const result = await this.streamAPI.sendStreamPrivate({
            fromUserId: this.config.accountId,
            toUserId: streamState!.targetId,
            content: delta,
            isFirstChunk,
            isLastChunk: false,
            seq: streamState!.seq,
            messageUID: streamState!.messageUID || null,
          });
          if (result.messageUID) streamState!.messageUID = result.messageUID;
        }

        streamState!.seq++;
        streamState!.hasSentStream = true;
        streamState!.lastSentTime = Date.now();
        log.info({ sessionId, seq: streamState!.seq - 1 }, 'Stream delta sent');
      } catch (err) {
        log.error({ err, sessionId, delta: delta.substring(0, 50) }, 'Stream delta send failed');
      }
    });

    await this.streamQueue;
  }

  private async handleSessionIdle(properties: { sessionID: string }): Promise<void> {
    const sessionId = properties.sessionID;

    // 立即标记已处理，防止并发重复发送
    if (this.sentSessions.has(sessionId)) {
      log.debug({ sessionId }, 'Already sent reply for this session, skipping');
      return;
    }
    this.sentSessions.add(sessionId);

    const streamState = this.streamStates.get(sessionId);

    // 如果已发送过流式片段，发送结束标记和 __stream_history__
    if (streamState && streamState.hasSentStream) {
      log.info({ sessionId, streamSeq: streamState.seq }, 'Finishing stream with last chunk');

      // 发送结束流式片段
      this.streamQueue = this.streamQueue.then(async () => {
        try {
          if (streamState.isGroup) {
            await this.streamAPI.sendStreamGroup({
              fromUserId: this.config.accountId,
              toGroupId: streamState.targetId,
              content: '',
              isFirstChunk: false,
              isLastChunk: true,
              seq: streamState.seq,
              messageUID: streamState.messageUID || null,
            });
          } else {
            await this.streamAPI.sendStreamPrivate({
              fromUserId: this.config.accountId,
              toUserId: streamState.targetId,
              content: '',
              isFirstChunk: false,
              isLastChunk: true,
              seq: streamState.seq,
              messageUID: streamState.messageUID || null,
            });
          }
          log.info({ sessionId, seq: streamState.seq }, 'Stream last chunk sent');
        } catch (err) {
          log.error({ err, sessionId }, 'Failed to send stream last chunk');
        }
      });
      await this.streamQueue;

      // 发送 __stream_history__ 普通文本消息作为持久化历史记录
      if (streamState.fullContent.trim()) {
        try {
          const historyContent = JSON.stringify({
            __stream_history__: true,
            streamId: streamState.messageUID || sessionId,
            text: streamState.fullContent,
            sentTime: Date.now(),
          });
          await this.rongClient.sendMessage(streamState.targetId, historyContent, streamState.isGroup ? 3 : 1);
          log.info({ sessionId, textLength: streamState.fullContent.length }, 'Stream history sent');
        } catch (err) {
          log.error({ err, sessionId }, 'Failed to send stream history');
        }
      }

      // 清理流式状态
      this.streamStates.delete(sessionId);
      this.sessionManager.updateStatus(streamState.chatId, 'idle');
      return;
    }

    // 清理流式状态（如果存在但未发送过流式）
    if (streamState) {
      this.streamStates.delete(sessionId);
    }

    log.info({ sessionId }, 'Handling session idle (no stream)');

    const chatId = this.sessionManager.getChatIdBySession(sessionId);
    if (!chatId) {
      log.warn({ sessionId }, 'No chatId found for session');
      return;
    }

    // 没有流式发送过时，兜底发送完整普通消息
    const text = await this.opencode.fetchLastMessageText(sessionId);
    log.info({ sessionId, chatId, hasText: !!text }, 'Fetched last message');

    if (text) {
      const targetId = chatId.replace('claw-', '');
      log.info({ targetId, textLength: text.length }, 'Sending reply via normal message');

      // 直接发送文本内容（前端期望的格式）
      await this.rongClient.sendMessage(targetId, text, 1);
    }

    this.sessionManager.updateStatus(chatId, 'idle');
  }

  private async handleMessagePartUpdated(properties: { sessionID: string; message?: any }): Promise<void> {
    const sessionId = properties.sessionID;

    // message.part.updated 表示消息片段已更新（非增量）
    // 如果已经在流式发送中（由 message.part.delta 驱动），忽略
    if (this.streamStates.has(sessionId)) {
      log.debug({ sessionId }, 'Stream already active via delta, ignoring part.updated');
      return;
    }

    // 需要 appSecret 才能调用融云服务端 API 发送流式消息
    if (!this.config.appSecret) {
      log.debug({ sessionId }, 'Streaming skipped: appSecret not configured, falling back to session.idle reply');
      return;
    }

    const chatId = this.sessionManager.getChatIdBySession(sessionId);
    if (!chatId) {
      log.warn({ sessionId }, 'No chatId found for message.part.updated');
      return;
    }

    // 如果已经发送过完整回复，跳过流式
    if (this.sentSessions.has(sessionId)) {
      log.debug({ sessionId }, 'Session already sent, skipping stream');
      return;
    }

    const targetId = chatId.replace('claw-', '');
    const isGroup = chatId.startsWith('group_');

    try {
      const text = await this.opencode.fetchLastMessageText(sessionId);
      if (!text) return;

    // 初始化流式状态
    let streamState = this.streamStates.get(sessionId);
    if (!streamState) {
      const chatId = this.sessionManager.getChatIdBySession(sessionId);
      if (!chatId) {
        log.warn({ sessionId }, 'No chatId found for message.part.updated');
        return;
      }

      streamState = {
        messageUID: '',
        seq: 1,  // 融云要求 seq 从 1 开始
        lastContent: '',
        lastSentTime: Date.now(),
        fullContent: '',
        hasSentStream: false,
        chatId,
        targetId: chatId.replace('claw-', ''),
        isGroup: chatId.startsWith('group_'),
      };
      this.streamStates.set(sessionId, streamState);
    }

      // 只发送新增内容
      const newContent = text.slice(streamState.lastContent.length);
      if (!newContent) return;

      // 累积完整内容
      streamState.fullContent += newContent;

      log.info({ sessionId, seq: streamState.seq, newLength: newContent.length }, 'Sending stream chunk (from part.updated)');

      // 使用队列确保流式消息片段串行发送
      this.streamQueue = this.streamQueue.then(async () => {
        try {
          if (isGroup) {
            const result = await this.streamAPI.sendStreamGroup({
              fromUserId: this.config.accountId,
              toGroupId: targetId,
              content: newContent,
              isFirstChunk: streamState!.seq === 1,
              isLastChunk: false,
              seq: streamState!.seq,
              messageUID: streamState!.messageUID || null,
            });
            if (result.messageUID) streamState!.messageUID = result.messageUID;
          } else {
            const result = await this.streamAPI.sendStreamPrivate({
              fromUserId: this.config.accountId,
              toUserId: targetId,
              content: newContent,
              isFirstChunk: streamState!.seq === 1,
              isLastChunk: false,
              seq: streamState!.seq,
              messageUID: streamState!.messageUID || null,
            });
            if (result.messageUID) streamState!.messageUID = result.messageUID;
          }

          streamState!.seq++;
          streamState!.hasSentStream = true;
          streamState!.lastContent = text;
          streamState!.lastSentTime = Date.now();
        } catch (err) {
          log.error({ err, sessionId, targetId }, 'Stream send failed');
          // 流式发送失败时清理状态，让 session.idle 兜底发送完整消息
          this.streamStates.delete(sessionId);
        }
      });

      await this.streamQueue;
    } catch (err) {
      log.error({ err, sessionId, targetId }, 'Stream processing failed');
      this.streamStates.delete(sessionId);
    }
  }

  private async handleMessageUpdated(properties: { sessionID: string; message?: any }): Promise<void> {
    const sessionId = properties.sessionID;

    // message.updated 只用于追踪消息内容更新，不发送消息
    // 如果已经在流式发送中，忽略
    if (this.streamStates.has(sessionId)) {
      return;
    }

    // 如果已发送，忽略
    if (this.sentSessions.has(sessionId)) {
      return;
    }

    // 只记录消息内容更新，不发送
    const chatId = this.sessionManager.getChatIdBySession(sessionId);
    if (!chatId) {
      log.warn({ sessionId }, 'No chatId found for message.updated');
      return;
    }

    const session = this.sessionManager.getSession(chatId);
    if (!session || session.status !== 'busy') {
      return;
    }

    // 尝试从事件的 message 对象直接获取文本（仅用于日志记录）
    const msg = properties.message;
    if (msg) {
      const role = msg.info?.role || msg.role;
      if (role === 'assistant' || role === 'model') {
        if (msg.parts && msg.parts.length > 0) {
          const textPart = msg.parts.find((p: any) => p.type === 'text');
          if (textPart?.text) {
            log.debug({ sessionId, textLength: textPart.text.length }, 'AI response content updated');
          }
        }
      }
    }
  }

  private handleStatusChange(properties: { sessionID: string; status: { type: string } }): void {
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (chatId && properties.status.type === 'busy') {
      this.sessionManager.updateStatus(chatId, 'busy');
      // Clear sentSessions to allow new replies in this session
      if (this.sentSessions.delete(properties.sessionID)) {
        log.debug({ sessionId: properties.sessionID }, 'Cleared sent flag for new message turn');
      }
    }
  }

  private async handleError(properties: { sessionID?: string; error: any }): Promise<void> {
    if (!properties.sessionID) return;
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    // 从错误对象中提取可读消息
    let errorMessage: string;
    if (typeof properties.error === 'string') {
      errorMessage = properties.error;
    } else if (properties.error?.data?.message) {
      errorMessage = properties.error.data.message;
    } else if (properties.error?.message) {
      errorMessage = properties.error.message;
    } else {
      errorMessage = 'AI 处理失败，请稍后重试';
    }

    // 标记为已处理，防止 session.idle 重复发送
    this.sentSessions.add(properties.sessionID);

    // 如果正在流式发送，清理状态
    const streamState = this.streamStates.get(properties.sessionID);
    if (streamState) {
      this.streamStates.delete(properties.sessionID);
    }

    log.error({ sessionId: properties.sessionID, error: errorMessage }, 'Session error');
    const targetId = chatId.replace('claw-', '');

    // 发送错误消息（直接文本格式）
    const errorText = `AI 处理出错: ${errorMessage}`;
    await this.rongClient.sendMessage(targetId, errorText, 1);
    this.sessionManager.updateStatus(chatId, 'idle');
  }
}
