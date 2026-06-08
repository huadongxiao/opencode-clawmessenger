import './env-polyfill.js';
import * as RongIMLibModule from '@rongcloud/imlib-next';
import type { Logger } from '../core/logger.js';
import type { RongCloudMessage } from '../core/types.js';

const RongIMLib: any = RongIMLibModule;

export class RongCloudClient {
  private config: { appKey: string; token: string; accountId: string };
  private log: Logger;
  private _isConnected = false;
  private messageHandler?: (msg: RongCloudMessage) => void;
  private sentMessageUIds = new Set<string>();
  private CommandMessage: any;
  private ServiceChatMessage: any;
  private OpsChatMessage: any;
  private OpsChatResponseMessage: any;
  private DeviceStatusRequestMessage: any;
  private DeviceStatusReportMessage: any;
  private DeviceControlMessage: any;
  private DeviceControlResultMessage: any;

  constructor(config: { appKey: string; token: string; accountId: string }, log: Logger) {
    this.config = config;
    this.log = log;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(handler: (msg: RongCloudMessage) => void): Promise<{ success: boolean; userId?: string }> {
    this.messageHandler = handler;
    this.log.info({ appKey: this.config.appKey, accountId: this.config.accountId }, '开始连接融云...');

    if (!RongIMLib || typeof RongIMLib.init !== 'function') {
      this.log.error('SDK 未正确加载');
      return { success: false };
    }

    RongIMLib.init({ appkey: this.config.appKey });
    this.log.info({ appKey: this.config.appKey }, '融云 SDK 已初始化');

    try {
      if (typeof RongIMLib.registerMessageType === 'function') {
        this.CommandMessage = RongIMLib.registerMessageType('command', false, false);
        this.ServiceChatMessage = RongIMLib.registerMessageType('service_chat', false, false);
        this.OpsChatMessage = RongIMLib.registerMessageType('ops_chat_message', false, false);
        this.OpsChatResponseMessage = RongIMLib.registerMessageType('ops_chat_response', false, false);
        // 注册设备状态和控制相关的自定义消息类型
        this.DeviceStatusRequestMessage = RongIMLib.registerMessageType('device_status_request', false, false);
        this.DeviceStatusReportMessage = RongIMLib.registerMessageType('device_status_report', false, false);
        this.DeviceControlMessage = RongIMLib.registerMessageType('device_control', false, false);
        this.DeviceControlResultMessage = RongIMLib.registerMessageType('device_control_result', false, false);
        this.log.info('自定义消息类型已注册 (command, service_chat, ops_chat_message, ops_chat_response, device_status_request, device_status_report, device_control, device_control_result)');
      }
    } catch (err: any) {
      this.log.warn({ err }, '注册自定义消息类型失败');
    }

    if (RongIMLib.addEventListener) {
      const eventName = RongIMLib.Events?.MESSAGES || 'MESSAGES';
      this.log.info({ eventName }, '注册消息监听器');
      RongIMLib.addEventListener(eventName, (event: any) => {
        this.log.info({ messageCount: event.messages?.length, eventType: event.type }, '融云消息事件触发');
        if (event.messages && event.messages.length > 0) {
          event.messages.forEach((msg: RongCloudMessage, index: number) => {
            this.log.info({
              index,
              messageType: msg.messageType,
              senderUserId: msg.senderUserId,
              targetId: msg.targetId,
              conversationType: msg.conversationType,
              messageUId: msg.messageUId,
              content: typeof msg.content === 'string' ? msg.content?.substring(0, 100) : JSON.stringify(msg.content)?.substring(0, 100),
            }, '原始消息内容');
            this.handleReceivedMessage(msg);
          });
        } else {
          this.log.warn({ event }, '融云消息事件没有消息内容');
        }
      });

      RongIMLib.addEventListener(RongIMLib.Events?.CONNECTED || 'CONNECTED', () => {
        this.log.info('融云连接成功');
        this._isConnected = true;
      });

      RongIMLib.addEventListener(RongIMLib.Events?.DISCONNECT || 'DISCONNECT', (code: any) => {
        this.log.warn({ code }, '融云断开连接');
        this._isConnected = false;
      });

      // 监听所有可能的事件用于调试
      const allEvents = ['MESSAGE_RECEIVED', 'TEXT_MESSAGE_RECEIVED', 'CUSTOM_MESSAGE_RECEIVED', 'CMD_MESSAGE_RECEIVED'];
      for (const evt of allEvents) {
        try {
          RongIMLib.addEventListener(evt, (data: any) => {
            this.log.info({ event: evt, data }, `融云事件: ${evt}`);
          });
        } catch {}
      }
    }

    try {
      const result = await RongIMLib.connect(this.config.token);
      if (result.code === 0 || result.code === 200) {
        const userId = result.data?.userId;
        this.log.info({ userId }, '融云登录成功');
        this._isConnected = true;
        // 如果融云返回的 userId 与配置的 accountId 不同，需要更新
        if (userId && userId !== this.config.accountId) {
          this.log.info({ configuredAccountId: this.config.accountId, actualUserId: userId }, '融云 userId 与配置 accountId 不一致，将使用融云 userId');
          this.config.accountId = userId;
        }
        return { success: true, userId };
      } else {
        this.log.error({ code: result.code }, '融云登录失败');
        return { success: false };
      }
    } catch (err: any) {
      this.log.error({ err }, '融云连接异常');
      return { success: false };
    }
  }

  private handleReceivedMessage(message: RongCloudMessage): void {
    try {
      // 打印所有收到的消息（用于调试）
      this.log.info({
        messageType: message.messageType,
        senderUserId: message.senderUserId,
        targetId: message.targetId,
        conversationType: message.conversationType,
        messageDirection: message.messageDirection,
        messageUId: message.messageUId,
        isOffLineMessage: message.isOffLineMessage,
        contentPreview: typeof message.content === 'string'
          ? message.content.substring(0, 200)
          : JSON.stringify(message.content).substring(0, 200),
      }, '收到原始消息');

      if (message.messageDirection === 1) {
        this.log.info({ messageType: message.messageType, senderUserId: message.senderUserId }, '忽略自己发送的消息');
        return;
      }
      if (message.senderUserId === this.config.accountId) {
        this.log.info({ messageType: message.messageType, senderUserId: message.senderUserId, accountId: this.config.accountId }, '忽略同一账号消息');
        return;
      }
      if (message.messageUId && this.sentMessageUIds.has(message.messageUId)) {
        this.log.info({ messageType: message.messageType, messageUId: message.messageUId }, '忽略已发送消息');
        return;
      }
      if (message.isOffLineMessage) {
        this.log.info({ messageType: message.messageType, senderUserId: message.senderUserId }, '忽略离线消息');
        return;
      }

      this.log.info({
        messageType: message.messageType,
        senderUserId: message.senderUserId,
        conversationType: message.conversationType,
      }, '消息通过过滤，准备处理');

      Promise.resolve().then(() => {
        this.messageHandler?.(message);
      }).catch((err: any) => {
        this.log.error({ err }, '消息处理异常');
      });

      // 注意：已读回执由 MessageHandler 在 handleMessage 入口处 fire-and-forget 发送
      // 支持单聊(V5/旧版)和群聊(V5/V2)已读回执
    } catch (err: any) {
      this.log.error({ err }, 'handleReceivedMessage 异常');
    }
  }

  async sendMessage(targetId: string, content: string, conversationType: number = 1): Promise<void> {
    if (!this._isConnected) {
      this.log.warn('融云未连接，无法发送消息');
      throw new Error('RongCloud not connected');
    }

    try {
      let messageContent: any;
      let parsedContent: any = null;
      try { parsedContent = JSON.parse(content); } catch {}

      if (parsedContent && parsedContent.msg_type) {
        const msgType = parsedContent.msg_type;
        if (msgType === 'ops_chat_message' && this.OpsChatMessage) {
          messageContent = new this.OpsChatMessage(parsedContent);
        } else if (msgType === 'ops_chat_response' && this.OpsChatResponseMessage) {
          messageContent = new this.OpsChatResponseMessage(parsedContent);
        } else if (msgType === 'service_chat' && this.ServiceChatMessage) {
          messageContent = new this.ServiceChatMessage(parsedContent);
        } else if (this.CommandMessage) {
          messageContent = new this.CommandMessage(parsedContent);
        } else {
          messageContent = { messageName: msgType, content };
        }
      } else {
        const safeContent = content || '';
        if (RongIMLib.TextMessage) {
          messageContent = new RongIMLib.TextMessage({ content: safeContent });
        } else {
          messageContent = { messageName: 'RC:TxtMsg', content: safeContent };
        }
      }

      const result = await RongIMLib.sendMessage(
        { conversationType, targetId },
        messageContent,
        { needReceipt: true },
      );

      if (result.code === 0 && result.data?.messageUId) {
        this.sentMessageUIds.add(result.data.messageUId);
        if (this.sentMessageUIds.size > 100) {
          const first = this.sentMessageUIds.values().next().value;
          if (first) this.sentMessageUIds.delete(first);
        }
      } else if (result.code !== 0) {
        throw new Error(`RongCloud send failed: code=${result.code}, msg=${result.msg || 'unknown'}`);
      }

      this.log.info({ targetId }, '消息发送成功');
    } catch (err: any) {
      this.log.error({ err, targetId }, '消息发送失败');
      throw err;
    }
  }

  async sendReadReceipt(msg: RongCloudMessage): Promise<void> {
    if (!this._isConnected) {
      this.log.warn('融云未连接，跳过已读回执');
      return;
    }

    const { conversationType, senderUserId, targetId, messageUId, sentTime } = msg;
    if (!messageUId || !sentTime) {
      this.log.warn({ messageUId, sentTime }, '消息缺少 messageUId 或 sentTime，无法发送已读回执');
      return;
    }

    // 本地生成的 messageUId 无法发送已读回执
    if (String(messageUId).startsWith('local-')) {
      this.log.warn({ messageUId }, 'messageUId 为本地生成，跳过已读回执');
      return;
    }

    this.log.info(
      { conversationType, senderUserId, targetId, messageUId, sentTime },
      '准备发送已读回执'
    );

    try {
      // 优先使用 V5 已读回执 API（与前端 enableReadV5 对齐）
      if (typeof RongIMLib.sendReadReceiptResponseV5 === 'function') {
        this.log.info({ targetId, messageUId }, '发送 V5 已读回执');
        const result = await RongIMLib.sendReadReceiptResponseV5(
          { conversationType, targetId },
          [messageUId]
        );
        this.log.info(
          { code: result.code, msg: result.msg, targetId, messageUId },
          'V5 已读回执结果'
        );
        return;
      }

      // 群聊回退到 V2 API
      if (conversationType === 3) {
        if (typeof RongIMLib.sendReadReceiptResponseV2 !== 'function') {
          this.log.warn('SDK 不支持群聊已读回执');
          return;
        }
        this.log.info({ targetId, messageUId }, '发送群聊已读回执 (V2)');
        const result = await RongIMLib.sendReadReceiptResponseV2(targetId, {
          [senderUserId]: [messageUId],
        });
        this.log.info(
          { code: result.code, msg: result.msg, targetId, messageUId },
          '群聊已读回执结果'
        );
        return;
      }

      // 单聊回退到旧版 API
      if (typeof RongIMLib.sendReadReceiptMessage !== 'function') {
        this.log.warn('SDK 不支持单聊已读回执');
        return;
      }
      this.log.info({ senderUserId, messageUId }, '发送单聊已读回执');
      const result = await RongIMLib.sendReadReceiptMessage(senderUserId, messageUId, sentTime);
      this.log.info(
        { code: result.code, msg: result.msg, senderUserId, messageUId },
        '单聊已读回执结果'
      );
    } catch (err: any) {
      this.log.error({ err: err.message || err, messageUId }, '发送已读回执异常');
    }
  }

  async clearUnreadStatus(conversationType: number, targetId: string): Promise<void> {
    if (!this._isConnected) {
      this.log.warn('融云未连接，跳过清除未读数');
      return;
    }
    this.log.info({ conversationType, targetId }, '准备清除未读数');
    try {
      const result = await RongIMLib.clearMessagesUnreadStatus({
        conversationType,
        targetId,
      });
      this.log.info({ code: result.code, conversationType, targetId }, '清除未读数结果');
      if (result.code === 0 || result.code === 200) {
        this.log.info({ targetId, conversationType }, '未读数清除成功');
      } else {
        this.log.warn({ code: result.code, msg: result.msg, targetId, conversationType }, '清除未读数失败');
      }
    } catch (err: any) {
      this.log.error({ err: err.message || err, targetId, conversationType }, '清除未读数异常');
    }
  }

  disconnect(): void {
    if (RongIMLib && typeof RongIMLib.disconnect === 'function') {
      RongIMLib.disconnect();
    }
    this._isConnected = false;
    this.log.info('融云连接已断开');
  }
}
