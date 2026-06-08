import { Command } from 'commander';
import { readFileSync, existsSync, unlinkSync, openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { startStandalone } from './standalone.js';
import { createLogger } from './core/logger.js';
import { PID_FILE, spawnDaemon, writePid, readPid, isProcessAlive, readStatus, statusFileAgeMs, HEARTBEAT_STALE_AFTER_MS, cleanupPid } from './core/daemon.js';

// Windows UTF-8 encoding fix - must be at the very top
if (process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    execSync('chcp 65001', { stdio: 'ignore' });
    // @ts-ignore
    process.env.FORCE_UTF8 = '1';
  } catch {}
}

const log = createLogger('cli');

function getVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
  } catch { return 'unknown'; }
}

const program = new Command();

program
  .name('opencode-clawmessenger')
  .description('OpenCode ClawMessenger Integration Plugin')
  .version(getVersion());

program
  .command('start')
  .description('Start the ClawMessenger plugin. Use --daemon to run as background service.')
  .option('-c, --config <path>', 'Configuration file path')
  .option('-u, --url <url>', 'OpenCode server URL')
  .option('-d, --daemon', 'Run as a background daemon')
  .option('-s, --serve', 'Auto-start opencode serve if not running')
  .action(async (options) => {
    try {
      const isDaemonChild = process.env.CLAW_DAEMONIZED === '1';

      if (!isDaemonChild && existsSync(PID_FILE)) {
        const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
        try {
          process.kill(pid, 0);
          console.error(`Plugin already running (PID ${pid}). Use "opencode-clawmessenger stop" first.`);
          process.exit(1);
        } catch { cleanupPid(); }
      }

      if (options.daemon && !isDaemonChild) {
        spawnDaemon(process.argv.slice(2));
        process.exit(0);
      }

      const pidDir = join(homedir(), '.config', 'opencode');
      if (!existsSync(pidDir)) mkdirSync(pidDir, { recursive: true });
      writePid(process.pid);

      await startStandalone({ configPath: options.config, autoServe: options.serve });
    } catch (err) {
      log.error({ err }, 'Failed to start');
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check plugin status')
  .option('--json', 'Emit JSON output')
  .action((options) => {
    const pid = readPid();
    const alive = pid != null && isProcessAlive(pid);
    const snap = readStatus();
    const age = statusFileAgeMs();
    const stale = age != null && age > HEARTBEAT_STALE_AFTER_MS;

    const state: string =
      !pid ? 'stopped' :
      !alive ? 'zombie' :
      stale ? 'stale' :
      'running';

    if (options.json) {
      process.stdout.write(JSON.stringify({ state, pid, snap, heartbeatAgeMs: age }, null, 2) + '\n');
      process.exit(state === 'running' ? 0 : 1);
    }

    switch (state) {
      case 'stopped':
        console.log('Plugin is not running');
        console.log('  Start it: opencode-clawmessenger start [--daemon]');
        break;
      case 'zombie':
        console.log(`PID file points to ${pid}, but process is not running`);
        console.log('  Clean up: opencode-clawmessenger stop');
        break;
      case 'stale':
        console.log(`Plugin PID ${pid} alive but heartbeat stale (${Math.round((age || 0) / 1000)}s old)`);
        break;
      case 'running':
        console.log('Plugin running');
        console.log(`  PID:         ${pid}`);
        if (snap) {
          const uptimeSec = Math.floor((Date.now() - snap.startedAt) / 1000);
          console.log(`  Uptime:      ${formatUptime(uptimeSec)}`);
          console.log(`  OpenCode:    ${snap.opencodeUrl}`);
          console.log(`  RongCloud:   ${snap.rongcloudConnected ? 'connected' : 'disconnected'}`);
          console.log(`  Sessions:    ${snap.sessionCount}`);
        }
        break;
    }

    process.exit(state === 'running' ? 0 : 1);
  });

program
  .command('stop')
  .description('Stop the ClawMessenger plugin')
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log('Plugin is not running');
      return;
    }

    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped plugin (PID: ${pid})`);
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        console.log('Process not found, cleaning up PID file');
      } else {
        console.error('Failed to stop plugin:', err.message);
      }
    } finally {
      cleanupPid();
    }
  });

program
  .command('logs')
  .description('Show recent plugin logs')
  .option('-n, --lines <n>', 'Lines to show from tail', '50')
  .option('-f, --follow', 'Follow the log')
  .action(async (options) => {
    const logPath = process.env.CLAW_LOG_FILE || join(homedir(), '.config', 'opencode', 'clawmessenger.log');

    if (!existsSync(logPath)) {
      process.stderr.write(`Log file not found: ${logPath}\n`);
      process.exit(1);
    }

    const n = parseInt(options.lines, 10) || 50;
    const data = readFileSync(logPath, 'utf-8');
    const lines = data.split('\n').filter(l => l.length > 0);
    const tail = lines.slice(-n);
    for (const line of tail) {
      process.stdout.write(line + '\n');
    }

    if (options.follow) {
      const { watchFile, unwatchFile, statSync } = await import('fs');
      let prevSize = statSync(logPath).size;

      watchFile(logPath, { interval: 500 }, (curr) => {
        if (curr.size > prevSize) {
          const fd = openSync(logPath, 'r');
          const buf = Buffer.alloc(curr.size - prevSize);
          readSync(fd, buf, 0, buf.length, prevSize);
          closeSync(fd);
          const newLines = buf.toString('utf-8').split('\n').filter(l => l.length > 0);
          for (const l of newLines) process.stdout.write(l + '\n');
          prevSize = curr.size;
        } else if (curr.size < prevSize) {
          prevSize = curr.size;
        }
      });

      process.on('SIGINT', () => { unwatchFile(logPath); process.exit(0); });
      await new Promise(() => {});
    }
  });

program
  .command('setup')
  .description('Configure the ClawMessenger plugin (auto-register + QR binding)')
  .action(async () => {
    const { getOrRegisterToken, loadAutoConfig, registerNode } = await import('./core/auto-register.js');
    const { getServerUrl } = await import('./core/auto-register.js');
    const { ConfigManager } = await import('./core/config.js');
    const { generateBindQR } = await import('./standalone.js');

    const rl = (await import('readline')).createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const question = (prompt: string) => new Promise<string>(resolve => rl.question(prompt, resolve));

    console.log('opencode-clawmessenger Setup Wizard\n');

    let configManager = new ConfigManager();
    let hasExisting = false;
    try {
      hasExisting = configManager.exists();
      if (hasExisting) {
        const cfg = configManager.load();
        if (cfg.token) {
          console.log('Existing config found:');
          console.log(`  Node ID:   ${cfg.accountId || 'unknown'}`);
          console.log(`  Server:    ${cfg.serverUrl}`);
          console.log(`  OpenCode:  ${cfg.opencodeUrl}\n`);

          const reset = await question('Re-register? (y/N): ');
          if (reset.toLowerCase() !== 'y') {
            console.log('\n========================================');
            console.log('  Current Binding QR Code');
            console.log('========================================\n');
            const { nodeId, qrData } = await generateBindQR();
            try {
              const QRCode = await import('qrcode');
              // 生成终端 ASCII 二维码
              const qrString = await QRCode.toString(qrData, { type: 'terminal', small: false });
              console.log('\n' + qrString + '\n');
            } catch {
              console.log('QR Data:', qrData);
            }
            console.log(`Node ID: ${nodeId}`);
            console.log('Tip: Open App -> AI Assistant -> Scan QR to Add');
            rl.close();
            return;
          }
        }
      }
    } catch {}

    const defaultName = (await import('os')).hostname();
    const nameInput = await question(`Node name [${defaultName}]: `);
    const nodeName = nameInput.trim() || defaultName;

    console.log(`\nRegistering node: ${nodeName}...`);
    const serverUrl = getServerUrl();
    const result = await registerNode(serverUrl, nodeName);

    if (!result.success) {
      console.error('Registration failed. Check network connectivity.');
      rl.close();
      process.exit(1);
    }

    console.log(`Registration successful!`);
    console.log(`  Node ID: ${result.nodeId}`);

    configManager = new ConfigManager();
    configManager.save({
      token: result.token,
      accountId: result.nodeId,
      nodeName,
    });

    console.log('\n========================================');
    console.log('  Scan QR Code with ClawMessenger App');
    console.log('========================================\n');

    const { nodeId, qrData } = await generateBindQR(nodeName);
    
    // 方法1: 生成终端 ASCII 二维码（最兼容）
    try {
      const QRCode = await import('qrcode');
      const qrString = await QRCode.toString(qrData, { type: 'terminal', small: false });
      console.log('\n' + qrString + '\n');
    } catch (err) {
      console.log('QR Code generation failed:', err);
    }
    
    console.log('\n----------------------------------------');
    console.log('Alternative binding methods:');
    console.log('----------------------------------------');
    console.log(`Node ID: ${nodeId}`);
    console.log(`Encrypted: ${qrData.substring(0, 50)}...`);
    console.log('\nIf QR scan fails, use manual input in app');
    console.log('Tip: Open App -> OpenClaw -> Manual Add');
    console.log('\nStart the plugin: opencode-clawmessenger start');

    rl.close();
  });

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s % 60}s`);
  return parts.join(' ');
}

program.parse();

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
