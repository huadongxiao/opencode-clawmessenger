import type { Plugin, PluginInput } from './types/plugin.js';
import { ConfigManager } from './core/config.js';
import { SessionManager } from './core/session-manager.js';
import { MessageHandler } from './core/message-handler.js';
import { RongCloudClient } from './rongcloud/client.js';
import { OpenCodeClient } from './opencode/client.js';
import { EventHandler } from './opencode/event-handler.js';
import { createLogger } from './core/logger.js';
import { getOrRegisterToken, loadAutoConfig, generateNodeId } from './core/auto-register.js';

const log = createLogger('plugin');

const ClawMessengerPlugin: Plugin = {
  id: 'clawmessenger',

  server: async (input: PluginInput) => {
    const { client, project, directory } = input;

    log.info('Initializing...');

    const configManager = new ConfigManager();
    const config = configManager.load();

    if (!config.token) {
      log.info('Token missing, auto-registering...');
      const token = await getOrRegisterToken(config.serverUrl, undefined, log);
      if (!token) throw new Error('自动注册失败，请运行: npx opencode-clawmessenger setup');
      config.token = token;
      config.accountId = (await loadAutoConfig())?.nodeId || generateNodeId();
    }

    log.info({ accountId: config.accountId, opencodeUrl: config.opencodeUrl }, 'Configuration loaded');

    const opencode = new OpenCodeClient({
      baseUrl: config.opencodeUrl,
      directory: directory || project?.root || process.cwd(),
      password: config.opencodePassword,
    });

    const sessionManager = new SessionManager(opencode);
    const rongClient = new RongCloudClient({
      appKey: config.appKey,
      token: config.token,
      accountId: config.accountId,
    }, log);

    const messageHandler = new MessageHandler(config, sessionManager, rongClient, opencode);

    let eventHandler: EventHandler | undefined;

    try {
      const events = client.event?.subscribe
        ? await client.event.subscribe({})
        : await client.global.event({});
      eventHandler = new EventHandler(sessionManager, rongClient, opencode, config);
      eventHandler.start(events).catch((err: any) => {
        log.error({ err }, 'Event stream error');
      });
    } catch (err) {
      log.warn({ err }, 'Failed to start event stream');
    }

    const connected = await rongClient.connect((msg) => {
      messageHandler.handleMessage(msg).catch((err) => {
        log.error({ err }, 'Message handling failed');
      });
    });

    if (!connected) throw new Error('融云连接失败');

    log.info('ClawMessenger plugin started');

    return {
      cleanup: async () => {
        log.info('Cleaning up...');
        if (eventHandler) eventHandler.stop();
        rongClient.disconnect();
        await sessionManager.cleanup();
      },
      /**
       * 发送消息给指定用户或群组
       * @param targetId 目标用户ID或群组ID
       * @param content 消息内容（纯文本或JSON字符串）
       * @param options 可选参数：conversationType(1=私聊,3=群聊，默认1)、extra(额外JSON字段)
       * @returns { success: boolean, messageUId?: string, error?: string }
       *
       * 使用示例：
       * - 私聊：await plugin.sendToUser('user123', '你好')
       * - 群聊：await plugin.sendToUser('group456', '大家好', { conversationType: 3 })
       * - 带额外数据：await plugin.sendToUser('admin', '需要添加知识库', { extra: { category: 'knowledge' } })
       */
      sendToUser: (targetId: string, content: string, options?: { conversationType?: number; extra?: Record<string, any> }) =>
        messageHandler.sendToUser(targetId, content, options),
    };
  },
};

export default ClawMessengerPlugin;
