import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { ClawMessengerConfig } from './types.js';
import { getServerUrl } from './auto-register.js';

const ClawMessengerConfigSchema = z.object({
  appKey: z.string().min(1).optional(),
  appSecret: z.string().optional(),
  token: z.string().optional(),
  accountId: z.string().optional(),
  nodeName: z.string().optional(),
  serverUrl: z.string().default(getServerUrl()),
  opencodeUrl: z.string().default('http://127.0.0.1:4096'),
  opencodeDir: z.string().optional(),
  opencodePassword: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  chatTimeout: z.number().min(1).default(600),
  hooks: z.object({
    onSessionCreated: z.string().optional(),
    onSessionIdle: z.string().optional(),
  }).optional(),
});

export class ConfigManager {
  private configPath: string;
  private config?: ClawMessengerConfig;

  constructor(configPath?: string) {
    this.configPath = configPath || join(homedir(), '.config', 'opencode', 'clawmessenger.json');
  }

  load(): ClawMessengerConfig {
    if (this.config) return this.config;

    let fileConfig: Record<string, any> = {};
    if (existsSync(this.configPath)) {
      try {
        fileConfig = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      } catch {}
    }

    const envConfig: Record<string, any> = {
      appKey: process.env.CLAW_APP_KEY,
      appSecret: process.env.CLAW_APP_SECRET,
      token: process.env.CLAW_TOKEN,
      accountId: process.env.CLAW_ACCOUNT_ID,
      serverUrl: process.env.DM_SERVER_URL,
      opencodeUrl: process.env.CLAW_OPENCODE_URL,
      opencodeDir: process.env.CLAW_OPENCODE_DIR,
      opencodePassword: process.env.OPENCODE_SERVER_PASSWORD,
      apiBaseUrl: process.env.CLAW_API_BASE_URL,
      chatTimeout: process.env.CLAW_CHAT_TIMEOUT ? parseInt(process.env.CLAW_CHAT_TIMEOUT, 10) : undefined,
    };

    for (const [k, v] of Object.entries(envConfig)) {
      if (v !== undefined && v !== '') {
        fileConfig[k] = v;
      }
    }

    this.config = ClawMessengerConfigSchema.parse(fileConfig) as ClawMessengerConfig;
    return this.config;
  }

  save(config: Partial<ClawMessengerConfig>): void {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let existing: Record<string, any> = {};
    if (existsSync(this.configPath)) {
      try { existing = JSON.parse(readFileSync(this.configPath, 'utf-8')); } catch {}
    }

    const merged = { ...existing, ...config };
    writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    this.config = undefined;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }
}

export { ClawMessengerConfigSchema };
