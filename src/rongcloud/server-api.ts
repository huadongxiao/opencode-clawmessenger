import { createHash, randomBytes } from 'crypto';
import { createLogger } from '../core/logger.js';

const log = createLogger('RongCloudServerAPI');

const API_HOSTS = ['api.rong-api.com', 'api-b.rong-api.com'];

export class RongCloudServerAPI {
  private appKey: string;
  private appSecret: string;
  private hostIndex = 0;

  constructor(appKey: string, appSecret: string) {
    this.appKey = appKey;
    this.appSecret = appSecret;
  }

  private get host(): string {
    return API_HOSTS[this.hostIndex];
  }

  private generateSignature(): { nonce: string; timestamp: number; signature: string } {
    const nonce = randomBytes(18).toString('base64url').slice(0, 18);
    const timestamp = Date.now();
    const source = this.appSecret + nonce + timestamp;
    const signature = createHash('sha1').update(source).digest('hex');
    return { nonce, timestamp, signature };
  }

  private getHeaders(contentType: string): Record<string, string> {
    const { nonce, timestamp, signature } = this.generateSignature();
    return {
      'App-Key': this.appKey,
      'Nonce': nonce,
      'Timestamp': String(timestamp),
      'Signature': signature,
      'Content-Type': contentType,
    };
  }

  private encodeForm(obj: Record<string, any>): string {
    return Object.entries(obj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))}`)
      .join('&');
  }

  private async requestJSON(path: string, data: any): Promise<any> {
    this.hostIndex = 0;
    for (let attempt = 0; attempt < API_HOSTS.length; attempt++) {
      const url = `https://${this.host}${path}`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this.getHeaders('application/json; charset=UTF-8'),
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(10000),
        });
        const result = await response.json() as any;
        if (result.code && result.code !== 200) {
          throw new Error(`[${result.code}] ${result.errorMessage || 'Unknown error'}`);
        }
        return result;
      } catch (err: any) {
        log.warn({ host: this.host, path, err: err.message }, 'Request failed');
        if (attempt < API_HOSTS.length - 1) {
          this.hostIndex++;
        } else {
          throw err;
        }
      }
    }
  }

  private async requestForm(path: string, data: Record<string, any>): Promise<any> {
    this.hostIndex = 0;
    for (let attempt = 0; attempt < API_HOSTS.length; attempt++) {
      const url = `https://${this.host}${path}`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this.getHeaders('application/x-www-form-urlencoded'),
          body: this.encodeForm(data),
          signal: AbortSignal.timeout(10000),
        });
        const result = await response.json() as any;
        if (result.code && result.code !== 200) {
          throw new Error(`[${result.code}] ${result.errorMessage || 'Unknown error'}`);
        }
        return result;
      } catch (err: any) {
        log.warn({ host: this.host, path, err: err.message }, 'Form request failed');
        if (attempt < API_HOSTS.length - 1) {
          this.hostIndex++;
        } else {
          throw err;
        }
      }
    }
  }

  async sendStreamPrivate(params: {
    fromUserId: string;
    toUserId: string;
    content: string;
    isFirstChunk: boolean;
    isLastChunk: boolean;
    seq: number;
    streamType?: string;
    messageUID?: string | null;
  }): Promise<{ messageUID?: string }> {
    const contentBody: Record<string, any> = {
      content: params.content,
      complete: params.isLastChunk,
      seq: params.seq,
    };

    if (params.isFirstChunk) {
      contentBody.type = params.streamType || 'markdown';
    }

    if (!params.isFirstChunk && params.messageUID) {
      contentBody.messageUID = params.messageUID;
    }

    const data: Record<string, any> = {
      fromUserId: params.fromUserId,
      toUserId: params.toUserId,
      objectName: 'RC:StreamMsg',
      content: contentBody,
      isPersisted: 1,
      isCounted: params.isFirstChunk ? 1 : 0,
      disableUpdateLastMsg: !params.isLastChunk,
    };

    log.info({ to: params.toUserId, seq: params.seq, first: params.isFirstChunk, last: params.isLastChunk }, 'Stream chunk');
    const result = await this.requestJSON('/v3/message/private/publish_stream.json', data);
    log.info({ to: params.toUserId, seq: params.seq, result }, 'Stream API response');
    return result;
  }

  async sendStreamGroup(params: {
    fromUserId: string;
    toGroupId: string;
    content: string;
    isFirstChunk: boolean;
    isLastChunk: boolean;
    seq: number;
    streamType?: string;
    messageUID?: string | null;
  }): Promise<{ messageUID?: string }> {
    const contentBody: Record<string, any> = {
      content: params.content,
      complete: params.isLastChunk,
      seq: params.seq,
    };

    if (params.isFirstChunk) {
      contentBody.type = params.streamType || 'markdown';
    }

    if (!params.isFirstChunk && params.messageUID) {
      contentBody.messageUID = params.messageUID;
    }

    const data: Record<string, any> = {
      fromUserId: params.fromUserId,
      toGroupId: params.toGroupId,
      objectName: 'RC:StreamMsg',
      content: contentBody,
      isPersisted: 1,
      isCounted: params.isFirstChunk ? 1 : 0,
      isIncludeSender: 1,
      disableUpdateLastMsg: !params.isLastChunk,
    };

    log.info({ to: params.toGroupId, seq: params.seq, first: params.isFirstChunk, last: params.isLastChunk }, 'Stream chunk group');
    return this.requestJSON('/v3/message/group/publish_stream.json', data);
  }

  async sendTypingStatus(fromUserId: string, toUserId: string, conversationType: number): Promise<void> {
    const path = conversationType === 3
      ? '/message/group/publish.json'
      : '/message/private/publish.json';

    await this.requestForm(path, {
      fromUserId,
      toUserId,
      objectName: 'RC:TypSts',
      content: JSON.stringify({ typingContentType: 'RC:TxtMsg' }),
      isPersisted: 0,
      isCounted: 0,
    });
  }
}
