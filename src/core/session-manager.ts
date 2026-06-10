import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { SessionInfo } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('SessionManager');

const DEFAULT_STORAGE_PATH = join(homedir(), '.config', 'opencode', 'clawmessenger-sessions.json');

interface PersistedSession {
  chatId: string;
  sessionId: string;
}

interface PersistedState {
  version: number;
  sessions: PersistedSession[];
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private creating = new Map<string, Promise<SessionInfo>>();
  private opencode: any;
  private storagePath: string;
  private saveTimer?: NodeJS.Timeout;

  constructor(opencode: any, storagePath?: string) {
    this.opencode = opencode;
    this.storagePath = storagePath || DEFAULT_STORAGE_PATH;
    this.restore();
  }

  async getOrCreateSession(chatId: string, title?: string): Promise<SessionInfo> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      try {
        const alive = await this.opencode.sessionExists(existing.id);
        if (alive) return existing;
        // Only delete if explicitly confirmed not alive, not on error
        this.sessions.delete(chatId);
      } catch (err) {
        // Network error: keep existing session, don't delete
        log.warn({ chatId, sessionId: existing.id, err }, 'sessionExists check failed, keeping existing session');
        return existing;
      }
    }

    const pending = this.creating.get(chatId);
    if (pending) return pending;

    const promise = (async (): Promise<SessionInfo> => {
      const session = await this.opencode.createSession(title || `ClawMessenger ${chatId}`);
      const info: SessionInfo = {
        id: session.id,
        chatId,
        status: 'idle',
      };
      this.sessions.set(chatId, info);
      log.info({ chatId, sessionId: session.id }, 'Created new session');
      this.scheduleSave();
      return info;
    })();

    this.creating.set(chatId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(chatId);
    }
  }

  getSession(chatId: string): SessionInfo | undefined {
    return this.sessions.get(chatId);
  }

  getSessionByOpencodeId(sessionId: string): SessionInfo | undefined {
    for (const [, info] of this.sessions.entries()) {
      if (info.id === sessionId) return info;
    }
    return undefined;
  }

  getChatIdBySession(sessionId: string): string | undefined {
    for (const [chatId, info] of this.sessions.entries()) {
      if (info.id === sessionId) return chatId;
    }
    return undefined;
  }

  updateStatus(chatId: string, status: 'idle' | 'busy'): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.status = status;
      log.info({ chatId, status }, 'Session status updated');
    }
  }

  updateExtra(chatId: string, extra: Record<string, any>): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.extra = { ...session.extra, ...extra };
      log.info({ chatId, extraKeys: Object.keys(extra) }, 'Session extra updated');
      this.scheduleSave();
    }
  }

  deleteSession(chatId: string): void {
    this.sessions.delete(chatId);
    this.scheduleSave();
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  async cleanup(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.saveNow();
  }

  private restore(): void {
    if (!existsSync(this.storagePath)) return;
    try {
      const data: PersistedState = JSON.parse(readFileSync(this.storagePath, 'utf-8'));
      if (data.version === 1 && Array.isArray(data.sessions)) {
        for (const s of data.sessions) {
          this.sessions.set(s.chatId, {
            id: s.sessionId,
            chatId: s.chatId,
            status: 'idle',
          });
        }
        log.info({ count: data.sessions.length }, 'Restored sessions');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to restore sessions');
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  private saveNow(): void {
    const state: PersistedState = {
      version: 1,
      sessions: Array.from(this.sessions.entries()).map(([chatId, info]) => ({
        chatId,
        sessionId: info.id,
      })),
    };
    try {
      const dir = dirname(this.storagePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.storagePath, JSON.stringify(state, null, 2));
    } catch (err) {
      log.error({ err }, 'Failed to save sessions');
    }
  }
}
