export interface ClawMessengerConfig {
  appKey: string;
  appSecret?: string;
  token: string;
  accountId: string;
  nodeName?: string;
  serverUrl: string;
  opencodeUrl: string;
  opencodeDir: string;
  opencodePassword?: string;
  apiBaseUrl?: string;
  chatTimeout?: number;
}

export interface RongCloudMessage {
  messageType: string;
  senderUserId: string;
  targetId: string;
  conversationType: number;
  content: string | { content?: string; [key: string]: any };
  isOffLineMessage: boolean;
  messageDirection: number;
  messageUId?: string;
  sentTime?: number;
  timestamp?: number;
}

export interface RongyunMessage {
  msg_type: string;
  content?: string;
  voiceUrl?: string;
  voiceDuration?: number;
  request_id?: string;
  source_im_id?: string;
  room_id?: string;
  gateway_session_id?: string;
  session_id?: string;
  [key: string]: any;
}

export enum RongyunMessageTypeEnum {
  CLIENT_CONNECTED = 'client_connected',
  CLIENT_DISCONNECTED = 'client_disconnected',
  HEARTBEAT = 'heartbeat',
  HEARTBEAT_ACK = 'heartbeat_ack',
  COMMAND = 'command',
  COMMAND_RESULT = 'command_result',
  PING = 'ping',
  PONG = 'pong',
  CHAT_MESSAGE = 'chat_message',
  CREATE_OPENCODE_SESSION = 'create_opencode_session',
  OPENCODE_SESSION_CREATED = 'opencode_session_created',
  DELETE_OPENCODE_SESSION = 'delete_opencode_session',
  SERVICE_CHAT_MESSAGE = 'service_chat_message',
  SERVICE_CHAT_RESPONSE = 'service_chat_response',
  CREATE_SERVICE_SESSION = 'create_service_session',
  SERVICE_SESSION_CREATED = 'service_session_created',
  DEVICE_STATUS_REQUEST = 'device_status_request',
  DEVICE_STATUS_REPORT = 'device_status_report',
  DEVICE_CONTROL = 'device_control',
  DEVICE_CONTROL_RESULT = 'device_control_result',
  OPS_CHAT_MESSAGE = 'ops_chat_message',
  OPS_CHAT_RESPONSE = 'ops_chat_response',
}

export interface SessionInfo {
  id: string;
  chatId: string;
  status: 'idle' | 'busy';
  lastUpdateTime?: number;
  currentContent?: string;
  extra?: Record<string, any>;
}

export interface HookConfig {
  onSessionCreated?: string;
  onSessionIdle?: string;
}

export type { PluginInput, PluginHooks, Plugin } from '../types/plugin.js';
