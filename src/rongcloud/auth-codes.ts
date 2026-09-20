/**
 * 融云鉴权错误码。
 *
 * 独立成不依赖 SDK 的模块：Token 换发逻辑（rongcloud/token-refresh.ts）需要
 * 判断错误码，但不应因此加载浏览器 SDK（Node 环境下 SDK 依赖 @rongcloud/engine）。
 */

/** Token 过期/失效/被顶下线时融云返回的错误码。 */
export const AUTHENTICATION_ERROR_CODES = new Set([1002, 31004, 31020, 31029]);

/** 从 SDK 返回结果或断开事件参数中取出错误码。 */
export function failureCode(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  const code = (value as { code?: unknown } | undefined)?.code;
  return typeof code === 'number' ? code : undefined;
}
