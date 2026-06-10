import type { RongCloudMessage, ClawMessengerConfig } from './types.js';
import { RongyunMessageTypeEnum } from './types.js';
import { MessageDeduplicator } from './dedup.js';
import { SessionManager } from './session-manager.js';
import { RongCloudClient } from '../rongcloud/client.js';
import { OpenCodeClient, checkOpencodeStatus } from '../opencode/client.js';
import { createLogger } from './logger.js';
import axios from 'axios';

const log = createLogger('MessageHandler');

export class MessageHandler {
  private config: ClawMessengerConfig;
  private sessionManager: SessionManager;
  private rongClient: RongCloudClient;
  private opencode: OpenCodeClient;
  private opsOpencode: OpenCodeClient;
  private dedup: MessageDeduplicator;
  // Command 消息请求等待队列（用于语音识别等异步操作）
  private pendingRequests: Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timer: NodeJS.Timeout }>;

  constructor(
    config: ClawMessengerConfig,
    sessionManager: SessionManager,
    rongClient: RongCloudClient,
    opencode: OpenCodeClient,
  ) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.rongClient = rongClient;
    this.opencode = opencode;
    // 运维助手使用独立的 OpenCode server（端口19877）
    this.opsOpencode = new OpenCodeClient({
      baseUrl: 'http://127.0.0.1:19877',
      directory: '/home/neomei/文档/projects/ops-assistant',
    });
    this.dedup = new MessageDeduplicator();
    this.pendingRequests = new Map();
  }

  /**
   * 发送消息给指定用户或群组
   * 供 agent 智能体调用，支持：
   * - 私聊：sendToUser('userId', '消息内容')
   * - 群聊：sendToUser('groupId', '消息内容', { conversationType: 3 })
   */
  async sendToUser(
    targetId: string,
    content: string,
    options: { conversationType?: number; extra?: Record<string, any> } = {},
  ): Promise<{ success: boolean; messageUId?: string; error?: string }> {
    const { conversationType = 1, extra } = options;

    if (!targetId || !content) {
      log.warn({ targetId, hasContent: !!content }, 'sendToUser: 缺少 targetId 或 content');
      return { success: false, error: '缺少 targetId 或 content' };
    }

    try {
      let messageContent: string;
      if (extra && Object.keys(extra).length > 0) {
        messageContent = JSON.stringify({ content, ...extra });
      } else {
        messageContent = content;
      }

      await this.rongClient.sendMessage(targetId, messageContent, conversationType);
      log.info({ targetId, conversationType, contentPreview: content.substring(0, 100) }, 'sendToUser: 消息发送成功');
      return { success: true };
    } catch (err: any) {
      log.error({ err, targetId, conversationType }, 'sendToUser: 消息发送失败');
      return { success: false, error: err.message || String(err) };
    }
  }

  async handleMessage(msg: RongCloudMessage): Promise<void> {
    try {
      // 过滤已读回执消息，避免日志噪音
      if (msg.messageType === 'RC:ReadNtf') {
        log.debug({ messageUId: msg.messageUId, senderUserId: msg.senderUserId }, 'Read receipt notification ignored');
        return;
      }

      if (msg.messageUId && this.dedup.isDuplicate(msg.messageUId)) {
        log.debug({ messageUId: msg.messageUId }, 'Duplicate message filtered');
        return;
      }

      // 发送已读回执（fire-and-forget，不阻塞消息处理）
      // 在消息去重之后、业务处理之前发送，确保只给实际处理的消息发送已读回执
      this.sendReadReceipt(msg);

      let msgContent: any;
      if (typeof msg.content === 'string') {
        try { msgContent = JSON.parse(msg.content); } catch { msgContent = { content: msg.content }; }
      } else if (msg.content && typeof msg.content === 'object') {
        msgContent = msg.content;
      } else {
        return;
      }

      let innerContent: any = {};
      if (msgContent.content && typeof msgContent.content === 'string') {
        try { innerContent = JSON.parse(msgContent.content); } catch { innerContent = { content: msgContent.content }; }
      }

      // 兼容驼峰和下划线两种命名方式
      const customMsgType = msgContent.msg_type;
      const sourceImId = msgContent.source_im_id || msgContent.sourceImId || msg.senderUserId;
      const destinationImId = msgContent.destination_im_id || msgContent.destinationImId || msg.targetId;
      const requestId = msgContent.request_id || msgContent.requestId;
      const merged = { 
        ...msgContent, 
        ...innerContent, 
        request_id: requestId, 
        source_im_id: sourceImId,
        destination_im_id: destinationImId,
      };

      // 过滤系统通知消息（前端通过 __sys_notify__ 标记发送），避免AI响应
      if (msgContent.__sys_notify__ === true || innerContent.__sys_notify__ === true) {
        log.debug({ messageType: msg.messageType, text: msgContent.text || innerContent.text }, 'System notification ignored');
        return;
      }

      log.info({ 
        messageType: msg.messageType, 
        customMsgType, 
        senderUserId: msg.senderUserId,
        targetId: msg.targetId,
        contentKeys: Object.keys(msgContent),
        hasMsgType: !!msgContent.msg_type,
        msgContentPreview: JSON.stringify(msgContent).substring(0, 200)
      }, 'Message received details');

      switch (customMsgType || msg.messageType) {
        case RongyunMessageTypeEnum.CREATE_OPENCODE_SESSION:
        case 'create_opencode_session':
          await this.handleCreateOpencodeSession(merged, msg);
          return;

        case 'RC:TxtMsg':
        case 'TextMessage':
          // RC:TxtMsg = 普通文本消息 → 点点（主OpenCode）
          await this.handleChatMessage(merged, msg, customMsgType);
          return;

        case RongyunMessageTypeEnum.CHAT_MESSAGE:
        case 'chat_message':
          // chat_message = 普通聊天消息 → 点点（主OpenCode）
          await this.handleChatMessage(merged, msg, customMsgType);
          return;

        case RongyunMessageTypeEnum.DEVICE_STATUS_REQUEST:
        case 'device_status_request':
          await this.handleDeviceStatusRequest(merged, msg);
          return;

        case RongyunMessageTypeEnum.DEVICE_CONTROL:
        case 'device_control':
          await this.handleDeviceControl(merged, msg);
          return;

        case 'command':
          await this.handleCommand(merged, msg);
          return;

        case RongyunMessageTypeEnum.OPS_CHAT_MESSAGE:
        case 'ops_chat_message':
          await this.handleOpsChatMessage(merged, msg);
          return;

        case RongyunMessageTypeEnum.CREATE_SERVICE_SESSION:
        case 'create_service_session':
          await this.handleCreateServiceSession(merged, msg);
          return;

        case RongyunMessageTypeEnum.SERVICE_CHAT_MESSAGE:
        case 'service_chat_message':
          await this.handleServiceChatMessage(merged, msg);
          return;

        case RongyunMessageTypeEnum.DELETE_OPENCODE_SESSION:
        case 'delete_opencode_session':
          if (merged.session_id) {
            this.sessionManager.deleteSession(merged.session_id);
            await this.opencode.deleteSession(merged.session_id);
          }
          return;

        case RongyunMessageTypeEnum.COMMAND_RESULT:
        case 'command_result':
          this.handleCommandResult(merged, msg);
          return;

        default:
          log.warn({ messageType: msg.messageType, customMsgType }, 'Unknown message type');
      }
    } catch (err) {
      log.error({ err }, '处理消息异常');
      try {
        const targetId = msg.conversationType === 3 ? msg.targetId : msg.senderUserId;
        // 不发送错误消息给 system 等虚拟用户（融云 20604 错误）
        if (targetId && targetId !== 'system') {
          const errorPayload = JSON.stringify({
            content: '处理失败，请稍后重试',
            extra: JSON.stringify({
              from_node: this.config.accountId,
              is_ai: true,
            }),
          });
          await this.rongClient.sendMessage(targetId, errorPayload, msg.conversationType);
        }
      } catch {}
    }
  }

  /**
   * 发送已读回执（fire-and-forget，不阻塞消息处理）
   * 在 handleMessage 入口处调用，支持单聊和群聊
   */
  private sendReadReceipt(msg: RongCloudMessage): void {
    // 跳过自己的消息
    if (msg.messageDirection === 1) {
      return;
    }

    // 需要有效的消息 UID 和时间戳
    if (!msg.messageUId || !msg.sentTime) {
      log.debug({ messageUId: msg.messageUId, sentTime: msg.sentTime }, 'Skip read receipt: invalid messageUId or sentTime');
      return;
    }

    // 本地生成的 messageUId 无法发送已读回执（已在 client.ts 过滤，此处二次保险）
    if (String(msg.messageUId).startsWith('local-')) {
      log.debug({ messageUId: msg.messageUId }, 'Skip read receipt: local messageUId');
      return;
    }

    // fire-and-forget：不 await，避免阻塞消息处理
    this.rongClient.sendReadReceipt(msg).catch((err) => {
      log.warn({ err, messageUId: msg.messageUId }, 'Failed to send read receipt');
    });
  }

  private async handleChatMessage(data: any, msg: RongCloudMessage, originalMsgType?: string): Promise<void> {
    const isGroup = msg.conversationType === 3;
    // 群聊时使用 group_<groupId> 作为 chatId，让 event-handler 正确识别为群聊并回复到群里
    const chatId = isGroup ? `group_${msg.targetId}` : `claw-${msg.senderUserId}`;
    const sessionId = data?.session_id || chatId;

    let content = '';
    if (data?.content) {
      content = typeof data.content === 'string' ? data.content : (data.content.content || JSON.stringify(data.content));
    } else if (data?._raw_content) {
      content = typeof data._raw_content === 'string' ? data._raw_content : JSON.stringify(data._raw_content);
    }

    if (!content) {
      log.warn('Chat message content is empty');
      return;
    }

    // 判断是否是设备对话：有 room_id 表示来自 device-chat.vue
    const isDeviceChat = !!data?.room_id;
    if (isDeviceChat) {
      log.info({ sessionId, roomId: data.room_id }, 'Device chat detected, routing to ops assistant');
      await this.handleDeviceChat(data, msg, content);
      return;
    }

    // 群聊 @ 判断逻辑
    if (isGroup) {
      // 从多个可能的位置提取 mentionedInfo（msg.content 可能是字符串或对象）
      let msgContentMentioned: any;
      if (msg.content && typeof msg.content === 'object') {
        msgContentMentioned = msg.content.mentionedInfo || msg.content.mentioned_info;
      } else if (typeof msg.content === 'string') {
        try {
          const parsed = JSON.parse(msg.content);
          msgContentMentioned = parsed.mentionedInfo || parsed.mentioned_info;
        } catch {}
      }
      const mentionedInfo = data?.mentionedInfo || data?.mentioned_info || msgContentMentioned;
      log.info({ 
        sessionId, 
        chatId, 
        content, 
        mentionedInfo: JSON.stringify(mentionedInfo),
        dataKeys: Object.keys(data || {}),
        accountId: this.config.accountId 
      }, 'Group chat mention check');
      
      if (mentionedInfo) {
        const userIdList = mentionedInfo.userIdList || mentionedInfo.user_id_list || [];
        // 融云 @所有人 的判断：userIdList 为空数组（无论 type 是 1 还是 2）
        // 实际测试发现 @所有人 时 type=1 且 userIdList=[]，@特定用户时 type=2 且有具体 userId
        const isAllMentioned = !userIdList || userIdList.length === 0;
        const isMentioned = isAllMentioned || userIdList.includes(this.config.accountId);
        
        log.info({ 
          userIdList, 
          isAllMentioned, 
          isMentioned, 
          accountId: this.config.accountId 
        }, 'Mention check result');
        
        if (!isMentioned) {
          // @了别的用户，当前 AI 不回复
          log.info('Not mentioned, skipping group chat reply');
          return;
        }
      }
      // 没有 @ 任何人，或者 @ 了当前 AI，继续处理
    }

    log.info({ sessionId, chatId, isGroup, contentLength: content.length }, 'Processing chat message');
    this.sessionManager.updateStatus(chatId, 'busy');

    try {
      const session = await this.sessionManager.getOrCreateSession(chatId, `ClawMessenger ${isGroup ? msg.targetId : msg.senderUserId}`);
      const isChatMessage = originalMsgType === 'chat_message' || originalMsgType === RongyunMessageTypeEnum.CHAT_MESSAGE;

      // 使用异步模式，通过 SSE 事件流实时推送回复
      // OpenCode 会自动加载 directory 下的 .opencode/prompt.md 作为 system prompt
      await this.opencode.sendPromptAsync(session.id, content);
      log.info({ sessionId, chatId, opencodeSessionId: session.id }, 'promptAsync sent, streaming via SSE');
    } catch (err) {
      log.error({ err, sessionId, chatId }, '处理聊天消息失败');
      this.sessionManager.updateStatus(chatId, 'idle');
      try {
        const errorPayload = JSON.stringify({
          content: '消息处理失败，请稍后重试',
          extra: JSON.stringify({
            from_node: this.config.accountId,
            is_ai: true,
          }),
        });
        await this.rongClient.sendMessage(
          msg.conversationType === 3 ? msg.targetId : msg.senderUserId,
          errorPayload,
          msg.conversationType,
        );
      } catch {}
    }
  }

  private async handleDeviceChat(data: any, msg: RongCloudMessage, content: string): Promise<void> {
    const roomId = data.room_id;
    const requestId = data.request_id || data.requestId;
    const targetId = data.source_im_id || data.sourceImId || msg.senderUserId;

    log.info({ roomId, targetId, contentLength: content.length }, 'Processing device chat via ops assistant');

    try {
      // 使用运维助手 OpenCodeClient（19877）同步获取回复
      const session = await this.opsOpencode.createSession(`Device-${roomId}`);
      log.info({ sessionId: session.id, roomId }, 'Created ops session for device chat');

      const response = await this.opsOpencode.sendPrompt(session.id, content);
      log.info({ roomId, responseLength: response.length }, 'Ops assistant responded for device chat');

      // 以 CHAT_MESSAGE 类型回复（匹配前端 device-rongyun-client 预期）
      const replyPayload = JSON.stringify({
        msg_type: RongyunMessageTypeEnum.CHAT_MESSAGE,
        request_id: requestId,
        content: response,
        status: 'success',
        room_id: roomId,
      });

      await this.rongClient.sendMessage(targetId, replyPayload, msg.conversationType);
      log.info({ targetId, roomId }, 'Device chat reply sent as CHAT_MESSAGE');
    } catch (err: any) {
      log.error({ err, roomId, targetId }, 'Device chat ops assistant failed');

      // 发送错误回复
      const errorPayload = JSON.stringify({
        msg_type: RongyunMessageTypeEnum.CHAT_MESSAGE,
        request_id: requestId,
        content: '运维助手处理失败: ' + (err.message || '未知错误'),
        status: 'error',
        room_id: roomId,
      });

      await this.rongClient.sendMessage(targetId, errorPayload, msg.conversationType);
    }
  }

  private async handleCreateOpencodeSession(data: any, msg: RongCloudMessage): Promise<void> {
    // 群聊(conversationType=3)时 targetId 是群ID，单聊时使用 source_im_id
    const targetId = msg.conversationType === 3
      ? msg.targetId
      : (data.source_im_id || data.sourceImId);
    const title = data.title || '新会话';

    try {
      const sessionId = `claw-${targetId}`;
      const session = await this.sessionManager.getOrCreateSession(sessionId, title);

      const response = {
        msg_type: RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED,
        request_id: data.request_id,
        source_im_id: data.destination_im_id || msg.targetId,
        destination_im_id: targetId,
        content: JSON.stringify({ status: 'success', opencode_session_id: session.id, session_id: sessionId, title }),
        timestamp: Math.floor(Date.now() / 1000),
      };

      await this.rongClient.sendMessage(targetId, JSON.stringify(response), msg.conversationType);
    } catch (err: any) {
      log.error({ err }, '创建 OpenCode 会话失败');
      const errorResponse = {
        msg_type: RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED,
        request_id: data.request_id,
        source_im_id: data.destination_im_id || msg.targetId,
        destination_im_id: targetId,
        content: JSON.stringify({ status: 'error', message: err.message }),
        timestamp: Math.floor(Date.now() / 1000),
      };
      await this.rongClient.sendMessage(targetId, JSON.stringify(errorResponse), msg.conversationType);
    }
  }

  private async handleDeviceStatusRequest(data: any, msg: RongCloudMessage): Promise<void> {
    // 群聊(conversationType=3)时 targetId 是群ID，单聊时是发送者ID
    const targetId = msg.conversationType === 3
      ? msg.targetId
      : (data.source_im_id || data.sourceImId || msg.senderUserId);

    try {
      const opencodeOk = await checkOpencodeStatus(this.config.opencodeUrl, this.config.opencodePassword);
      const statusData = {
        open_claw_status: opencodeOk ? 1 : 0,
        status_message: opencodeOk ? '运行中' : '未运行',
        version: 'unknown',
        timestamp: Date.now(),
      };

      const report = {
        msg_type: RongyunMessageTypeEnum.DEVICE_STATUS_REPORT,
        request_id: data.request_id,
        source_im_id: this.config.accountId,
        destination_im_id: targetId,
        content: JSON.stringify(statusData),
        timestamp: Math.floor(Date.now() / 1000),
      };

      await this.rongClient.sendMessage(targetId, JSON.stringify(report), msg.conversationType);
    } catch (err: any) {
      log.error({ err }, '设备状态查询异常');
    }
  }

  private async handleDeviceControl(data: any, msg: RongCloudMessage): Promise<void> {
    // 群聊(conversationType=3)时 targetId 是群ID，单聊时是发送者ID
    const targetId = msg.conversationType === 3
      ? msg.targetId
      : (data.source_im_id || data.sourceImId || msg.senderUserId);

    // 解析 content 字段中的 JSON（文档规范：content 包含 {"cmd": 1}）
    let commandContent: any = {};
    try {
      if (data.content && typeof data.content === 'string') {
        commandContent = JSON.parse(data.content);
      } else if (data.content && typeof data.content === 'object') {
        commandContent = data.content;
      }
    } catch {
      commandContent = {};
    }

    const cmd = commandContent.cmd;
    const cmdNames: Record<number, string> = {
      1: 'start',
      2: 'stop',
      3: 'restart',
      4: 'status',
      5: 'config_fix',
    };
    const cmdName = cmdNames[cmd] || `unknown(${cmd})`;

    log.info({ targetId, cmd, cmdName }, 'Processing device control');

    const result = {
      msg_type: RongyunMessageTypeEnum.DEVICE_CONTROL_RESULT,
      request_id: data.request_id,
      command: cmdName,
      cmd: cmd,
      status: 'success',
      message: `命令 ${cmdName} 已接收`,
      timestamp: Math.floor(Date.now() / 1000),
    };
    await this.rongClient.sendMessage(targetId, JSON.stringify(result), msg.conversationType);
  }

  private async handleCommand(data: any, msg: RongCloudMessage): Promise<void> {
    // 如果 command 消息中嵌套了其他 msg_type，路由到对应的 handler
    const nestedMsgType = data.msg_type;
    if (nestedMsgType && nestedMsgType !== 'command' && nestedMsgType !== RongyunMessageTypeEnum.COMMAND) {
      log.info({ nestedMsgType }, 'Command message contains nested msg_type, routing');
      switch (nestedMsgType) {
        case RongyunMessageTypeEnum.OPS_CHAT_MESSAGE:
        case 'ops_chat_message':
          await this.handleOpsChatMessage(data, msg);
          return;
        case RongyunMessageTypeEnum.DEVICE_CONTROL:
        case 'device_control':
          await this.handleDeviceControl(data, msg);
          return;
        case RongyunMessageTypeEnum.DEVICE_STATUS_REQUEST:
        case 'device_status_request':
          await this.handleDeviceStatusRequest(data, msg);
          return;
      }
    }

    // 支持两种格式：requestId（驼峰）和 request_id（下划线）
    const requestId = data.requestId || data.request_id;
    const service = data.service;
    const action = data.action;
    const payload = data.payload || {};
    const sourceId = data.source_im_id || data.sourceImId || msg.senderUserId;
    const destinationId = data.destination_im_id || data.destinationImId || msg.targetId;

    // 过滤无效命令：service/action 为空时不处理（避免回复给 system 等虚拟用户）
    if (!service || !action) {
      log.debug({ requestId, senderUserId: msg.senderUserId }, 'Skipping command with empty service/action');
      return;
    }

    log.info({ requestId, service, action }, 'Handling command');

    // 动态路由：_handle_{service}_{action}
    const handlerName = `_handle_${service}_${action}`;
    let result: any;

    try {
      if (typeof (this as any)[handlerName] === 'function') {
        result = await (this as any)[handlerName](payload, sourceId);
      } else {
        log.warn({ handlerName }, 'Command handler not found');
        result = {
          code: 404,
          message: `Unknown service/action: ${service}/${action}`,
          status: 'error',
        };
      }
    } catch (err: any) {
      log.error({ err, handlerName }, 'Command handler error');
      result = {
        code: 500,
        message: err.message || 'Internal server error',
        status: 'error',
      };
    }

    const response = {
      msg_type: RongyunMessageTypeEnum.COMMAND_RESULT,
      requestId: requestId,
      service: service,
      action: action,
      status: result.status || 'success',
      code: result.code || 200,
      data: result.data || null,
      message: result.message || 'success',
      timestamp: Date.now(),
    };

    await this.rongClient.sendMessage(sourceId, JSON.stringify(response), msg.conversationType);
  }

  /**
   * 处理 command_result 消息（响应回调）
   * 用于语音识别等异步操作的响应
   */
  private handleCommandResult(data: any, msg: RongCloudMessage): void {
    const requestId = data.requestId || data.request_id;
    if (!requestId) {
      log.warn('Command result missing requestId');
      return;
    }

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      log.warn({ requestId }, 'No pending request found for command result');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    if (data.status === 'success' && data.code === 200) {
      pending.resolve(data.data);
    } else {
      pending.reject(new Error(data.message || '语音识别失败'));
    }

    log.info({ requestId, status: data.status, code: data.code }, 'Command result processed');
  }

  // ========== Command Handlers ==========

  private async _handle_user_getInfo(payload: any, fromUserId: string): Promise<any> {
    return {
      code: 200,
      message: 'success',
      status: 'success',
      data: {
        userId: fromUserId,
        username: 'user',
        nickname: 'User',
        portraitUri: '',
        phone: '',
        email: '',
        signature: '',
        gender: '',
        birthday: '',
        status: 'active',
      },
    };
  }

  private async _handle_user_login(payload: any, fromUserId: string): Promise<any> {
    return {
      code: 200,
      message: 'Login successful',
      status: 'success',
      data: {
        userId: fromUserId,
        token: this.config.token,
      },
    };
  }

  private async _handle_claw_getStatus(payload: any, fromUserId: string): Promise<any> {
    const isRunning = this.opencode !== null;
    return {
      code: 200,
      message: 'success',
      status: 'success',
      data: {
        nodeId: this.config.accountId,
        status: isRunning ? 'online' : 'offline',
        openclawUrl: this.config.opencodeUrl,
        version: '1.0.0',
      },
    };
  }

  private async _handle_claw_start(payload: any, fromUserId: string): Promise<any> {
    return {
      code: 200,
      message: 'Node started',
      status: 'success',
      data: { nodeId: this.config.accountId, status: 'online' },
    };
  }

  private async _handle_claw_stop(payload: any, fromUserId: string): Promise<any> {
    return {
      code: 200,
      message: 'Node stopped',
      status: 'success',
      data: { nodeId: this.config.accountId, status: 'offline' },
    };
  }

  private async _handle_system_getConfig(payload: any, fromUserId: string): Promise<any> {
    return {
      code: 200,
      message: 'success',
      status: 'success',
      data: {
        appKey: this.config.appKey,
        serverUrl: this.config.serverUrl,
      },
    };
  }

  private async handleCreateServiceSession(data: any, msg: RongCloudMessage): Promise<void> {
    const userId = data.userId || data.user_id || msg.senderUserId;
    const targetId = msg.senderUserId;
    const requestId = data.request_id || data.requestId;

    log.info({ userId, targetId, requestId }, 'Processing create service session');

    try {
      const chatId = `service-${userId}`;
      const session = await this.sessionManager.getOrCreateSession(chatId, `客服会话 ${userId}`);

      const response = {
        msg_type: RongyunMessageTypeEnum.SERVICE_SESSION_CREATED,
        request_id: requestId,
        userId: userId,
        sessionId: session.id,
        status: 'success',
        message: '客服会话创建成功',
        timestamp: Math.floor(Date.now() / 1000),
      };

      await this.rongClient.sendMessage(targetId, JSON.stringify(response), msg.conversationType);
      log.info({ userId, sessionId: session.id }, 'Service session created');
    } catch (err: any) {
      log.error({ err, userId }, '创建客服会话失败');
      const errorResponse = {
        msg_type: RongyunMessageTypeEnum.SERVICE_SESSION_CREATED,
        request_id: requestId,
        userId: userId,
        status: 'error',
        message: err.message || '创建会话失败',
        timestamp: Math.floor(Date.now() / 1000),
      };
      await this.rongClient.sendMessage(targetId, JSON.stringify(errorResponse), msg.conversationType);
    }
  }

  /**
   * 语音识别：通过融云 command 消息发送识别请求，等待 command_result 响应
   * 不再使用 HTTP 调用，改为 RongCloud 消息通道
   */
  private async _recognizeVoice(voiceUrl: string): Promise<string> {
    const requestId = `vr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    return new Promise((resolve, reject) => {
      // 30秒超时
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('语音识别请求超时'));
      }, 30000);

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      const commandPayload = {
        msg_type: RongyunMessageTypeEnum.COMMAND,
        requestId: requestId,
        service: 'ai',
        action: 'recognizeVoice',
        payload: {
          voiceUrl: voiceUrl,
          format: 'm4a',
          sampleRate: 16000,
        },
        timestamp: Date.now(),
      };

      // 发送给 system 用户（Python server 端处理）
      this.rongClient.sendMessage('system', JSON.stringify(commandPayload), 1)
        .then(() => {
          log.info({ requestId, voiceUrl }, 'Voice recognition command sent via RongCloud');
        })
        .catch((err: any) => {
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          log.error({ err: err.message, requestId }, 'Failed to send voice recognition command');
          reject(new Error('发送语音识别请求失败: ' + (err.message || '未知错误')));
        });
    }).then((data: any) => {
      const text = data?.text || data?.result || '';
      if (!text) {
        throw new Error('语音识别结果为空');
      }
      log.info({ voiceUrl, recognizedTextPreview: text.substring(0, 100) }, 'Voice recognized via RongCloud');
      return text;
    });
  }

  private async handleServiceChatMessage(data: any, msg: RongCloudMessage): Promise<void> {
    const userId = data.userId || data.user_id || msg.senderUserId;
    const sessionId = data.sessionId || data.session_id;
    let content = data.content || '';
    const targetId = msg.senderUserId;
    const requestId = data.request_id || data.requestId;

    // 处理语音消息：如果有 voiceUrl，先进行语音识别
    if (data.voiceUrl && !content) {
      try {
        content = await this._recognizeVoice(data.voiceUrl);
        log.info({ userId, voiceUrl: data.voiceUrl, recognizedLength: content.length }, 'Voice message recognized');
      } catch (err: any) {
        log.error({ err, userId, voiceUrl: data.voiceUrl }, 'Voice recognition failed for service chat');
        const errorPayload = JSON.stringify({
          msg_type: RongyunMessageTypeEnum.SERVICE_CHAT_RESPONSE,
          request_id: requestId,
          content: '语音消息识别失败，请稍后重试或发送文字消息',
          sessionId: sessionId || '',
          userId: userId,
          status: 'error',
          timestamp: Math.floor(Date.now() / 1000),
        });
        await this.rongClient.sendMessage(targetId, errorPayload, msg.conversationType);
        return;
      }
    }

    if (!content) {
      log.warn('Service chat message content is empty');
      return;
    }

    log.info({ userId, sessionId, contentLength: content.length }, 'Processing service chat message');

    try {
      const chatId = `service-${userId}`;
      const session = await this.sessionManager.getOrCreateSession(chatId, `客服会话 ${userId}`);

      // 保存客服目标账号ID到 session，供 event-handler 发送回复时使用
      // 这样客服回复的 fromUserId 会是客服账号，而不是当前节点ID
      const serviceTargetId = msg.targetId || this.config.accountId;
      this.sessionManager.updateExtra(chatId, { serviceTargetId });
      log.info({ userId, sessionId: session.id, serviceTargetId }, 'Service session created with targetId');

      // 使用异步模式触发 SSE 流式输出，由 event-handler 处理流式消息发送
      // 最终回复会在 session.idle 时以 service_chat_response 格式发送
      await this.opencode.sendPromptAsync(session.id, content);
      log.info({ userId, sessionId: session.id }, 'Service promptAsync sent, streaming via SSE');
    } catch (err: any) {
      log.error({ err, userId, targetId }, 'Service assistant failed');

      const errorPayload = JSON.stringify({
        msg_type: RongyunMessageTypeEnum.SERVICE_CHAT_RESPONSE,
        request_id: requestId,
        content: '客服处理失败: ' + (err.message || '未知错误'),
        sessionId: sessionId || '',
        userId: userId,
        status: 'error',
        timestamp: Math.floor(Date.now() / 1000),
      });

      await this.rongClient.sendMessage(targetId, errorPayload, msg.conversationType);
    }
  }

  private async handleOpsChatMessage(data: any, msg: RongCloudMessage): Promise<void> {
    // 群聊(conversationType=3)时 targetId 是群ID，单聊时是发送者ID
    const targetId = msg.conversationType === 3
      ? msg.targetId
      : (data.source_im_id || data.sourceImId || msg.senderUserId);
    const content = data.message || data.content || '';
    const nodeId = data.node_id || data.nodeId;
    const requestId = data.request_id || data.requestId;

    if (!content) {
      log.warn('Ops chat message content is empty');
      return;
    }

    log.info({ targetId, nodeId, contentLength: content.length }, 'Processing ops chat message');

    try {
      // 使用独立的运维 OpenCodeClient（19877）发送消息
      // 通过 API 显式传递 system prompt，确保加载运维助手人设
      const session = await this.opsOpencode.createSession(`Ops-${targetId}`);
      log.info({ sessionId: session.id }, 'Created ops session');
      
      const response = await this.opsOpencode.sendPrompt(session.id, content);
      log.info({ targetId, responseLength: response.length }, 'Ops assistant responded');

      // 发送自定义消息回复: 按照规范包装 AI 回复
      // 同时发送 TextMessage 确保前端兼容显示
      const replyPayload = JSON.stringify({
        msg_type: RongyunMessageTypeEnum.OPS_CHAT_RESPONSE,
        request_id: requestId,
        reply: response,
        node_id: nodeId || this.config.accountId,
      });
      
      // TextMessage 用于前端显示（RCUIKit 聊天组件兼容）
      const textPayload = JSON.stringify({
        content: response,
        extra: JSON.stringify({
          from_node: this.config.accountId,
          is_ai: true,
          msg_type: RongyunMessageTypeEnum.OPS_CHAT_RESPONSE,
          chat_type: 'ops',
        }),
      });
      
      // 先发自定义消息，再发 TextMessage
      await this.rongClient.sendMessage(targetId, replyPayload, msg.conversationType);
      await this.rongClient.sendMessage(targetId, textPayload, msg.conversationType);
    } catch (err: any) {
      log.error({ err, targetId }, 'Ops assistant failed');
      const errorReply = JSON.stringify({
        msg_type: RongyunMessageTypeEnum.OPS_CHAT_RESPONSE,
        request_id: requestId,
        reply: '运维助手处理失败: ' + (err.message || '未知错误'),
        node_id: nodeId || this.config.accountId,
      });
      
      const errorTextPayload = JSON.stringify({
        content: '运维助手处理失败: ' + (err.message || '未知错误'),
        extra: JSON.stringify({
          from_node: this.config.accountId,
          is_ai: true,
          msg_type: RongyunMessageTypeEnum.OPS_CHAT_RESPONSE,
        }),
      });
      
      await this.rongClient.sendMessage(targetId, errorReply, msg.conversationType);
      await this.rongClient.sendMessage(targetId, errorTextPayload, msg.conversationType);
    }
  }
}
