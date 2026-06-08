import { mkdirSync, existsSync, createWriteStream } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import pino, { type Logger } from 'pino';
import pinoPretty from 'pino-pretty';

// Fix Windows PowerShell UTF-8 encoding — MUST run before any logging
if (process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    execSync('chcp 65001', { stdio: 'ignore' });
    // @ts-ignore
    process.stdout.setDefaultEncoding('utf8');
    // @ts-ignore
    process.stderr.setDefaultEncoding('utf8');
  } catch {}
}

const DEFAULT_LOG_PATH = join(homedir(), '.config', 'opencode', 'clawmessenger.log');
const level = process.env.CLAW_LOG_LEVEL?.toLowerCase() || 'info';
const logFile = process.env.CLAW_LOG_FILE || DEFAULT_LOG_PATH;

const logDir = dirname(logFile);
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

const isWindows = process.platform === 'win32';
const streams: any[] = [
  { level, stream: createWriteStream(logFile, { flags: 'a' }) },
];

if (process.stderr.isTTY) {
  // Use pino-pretty as an in-process stream (not a subprocess via transport)
  // This ensures the Windows console encoding fix above actually applies
  streams.push({
    level,
    stream: pinoPretty({
      colorize: !isWindows,
      singleLine: true,
      translateTime: 'HH:MM:ss',
      messageFormat: isWindows ? '[{level}] {msg}' : undefined,
      destination: process.stderr,
      // On Windows, force sync output to avoid buffering issues with encoding
      sync: true,
    }),
  });
}

export const rootLogger: Logger = pino(
  { level, base: undefined },
  pino.multistream(streams)
);

export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger.child({ module, ...bindings });
}

export type { Logger };
