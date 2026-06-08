import type { RongCloudMessage, ClawMessengerConfig } from './types.js';
import { RongyunMessageTypeEnum } from './types.js';
import { MessageDeduplicator } from './dedup.js';
import { SessionManager } from './session-manager.js';
import { RongCloudClient } from '../rongcloud/client.js';
import { OpenCodeClient, checkOpencodeStatus } from '../opencode/client.js';
import { createLogger } from './logger.js';

const log = createLogger('MessageHandler');

export class MessageHandler {
  private config: ClawMessengerConfig;
  private sessionManager: SessionManager;
  private rongClient: RongCloudClient;
  private opencode: OpenCodeClient;
  private opsOpencode: OpenCodeClient;
  private dedup: MessageDeduplicator;
  // 已读回执在 handleMessage 入口处 fire-and-forget 发送，无需 pending 队列

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

        case RongyunMessageTypeEnum.DELETE_OPENCODE_SESSION:
        case 'delete_opencode_session':
          if (merged.session_id) {
            this.sessionManager.deleteSession(merged.session_id);
            await this.opencode.deleteSession(merged.session_id);
          }
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
    const sessionId = data?.session_id || `claw-${msg.senderUserId}`;

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

    log.info({ sessionId, contentLength: content.length }, 'Processing chat message');
    this.sessionManager.updateStatus(sessionId, 'busy');

    try {
      const session = await this.sessionManager.getOrCreateSession(sessionId, `ClawMessenger ${msg.senderUserId}`);
      const isChatMessage = originalMsgType === 'chat_message' || originalMsgType === RongyunMessageTypeEnum.CHAT_MESSAGE;

      // 使用异步模式，通过 SSE 事件流实时推送回复
      // OpenCode 会自动加载 directory 下的 .opencode/prompt.md 作为 system prompt
      await this.opencode.sendPromptAsync(session.id, content);
      log.info({ sessionId, opencodeSessionId: session.id }, 'promptAsync sent, streaming via SSE');
    } catch (err) {
      log.error({ err, sessionId }, '处理聊天消息失败');
      this.sessionManager.updateStatus(sessionId, 'idle');
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
