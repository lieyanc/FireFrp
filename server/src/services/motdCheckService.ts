import { mcPing, McPingResult } from './mcPing';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getMessageHeader } from '../version';

const log = logger.child({ module: 'motdCheck' });

// Check intervals after tunnel activation
const CHECK_DELAYS_MS = [
  15 * 1000,       // 15 seconds
  1 * 60 * 1000,   // 1 minute
  3 * 60 * 1000,   // 3 minutes
  5 * 60 * 1000,   // 5 minutes
  10 * 60 * 1000,  // 10 minutes
];

interface PendingCheck {
  tunnelId: string;
  groupId: number;
  userId: number;
  userName: string;
  host: string;
  port: number;
  timers: NodeJS.Timeout[];
  resolved: boolean;
}

const pendingChecks = new Map<string, PendingCheck>();

// Late-import to avoid circular dependency (qqBot → commands → keyService ↔ motdCheckService)
let _qqBot: typeof import('../bot/qqBot').qqBot | null = null;

async function getBot() {
  if (!_qqBot) {
    const mod = await import('../bot/qqBot');
    _qqBot = mod.qqBot;
  }
  return _qqBot;
}

/**
 * Start MOTD auto-check for a newly connected Minecraft tunnel.
 * Schedules checks at 1min, 3min, 5min, and 10min after activation.
 */
export function startMotdCheck(
  tunnelId: string,
  groupId: number,
  userId: number,
  userName: string,
  remotePort: number,
): void {
  // Cancel any existing check for this tunnel
  cancelMotdCheck(tunnelId);

  const host = config.server.publicAddr;
  const port = remotePort;

  const entry: PendingCheck = {
    tunnelId,
    groupId,
    userId,
    userName,
    host,
    port,
    timers: [],
    resolved: false,
  };

  for (let i = 0; i < CHECK_DELAYS_MS.length; i++) {
    const delay = CHECK_DELAYS_MS[i];
    const isLast = i === CHECK_DELAYS_MS.length - 1;

    const timer = setTimeout(() => {
      performCheck(tunnelId, isLast).catch((err) => {
        log.error({ err, tunnelId }, 'Unexpected error in MOTD check');
      });
    }, delay);

    entry.timers.push(timer);
  }

  pendingChecks.set(tunnelId, entry);
  log.info({ tunnelId, host, port }, 'MOTD auto-check started');
}

/**
 * Cancel all pending MOTD checks for a tunnel.
 * Called when the tunnel disconnects.
 */
export function cancelMotdCheck(tunnelId: string): void {
  const entry = pendingChecks.get(tunnelId);
  if (!entry) return;

  for (const timer of entry.timers) {
    clearTimeout(timer);
  }
  pendingChecks.delete(tunnelId);
  log.info({ tunnelId }, 'MOTD auto-check cancelled');
}

/**
 * Cancel all pending MOTD checks.
 * Called during graceful shutdown.
 */
export function cancelAll(): void {
  for (const [, entry] of pendingChecks) {
    for (const timer of entry.timers) {
      clearTimeout(timer);
    }
  }
  pendingChecks.clear();
  log.info('All MOTD auto-checks cancelled');
}

/**
 * Perform a single MOTD check for a tunnel.
 */
async function performCheck(tunnelId: string, isLast: boolean): Promise<void> {
  const entry = pendingChecks.get(tunnelId);
  if (!entry || entry.resolved) return;

  log.debug({ tunnelId, host: entry.host, port: entry.port, isLast }, 'Performing MOTD check');

  try {
    const result = await mcPing(entry.host, entry.port, 5000);

    // Success — mark resolved, cancel remaining timers, notify group
    entry.resolved = true;
    for (const timer of entry.timers) {
      clearTimeout(timer);
    }
    pendingChecks.delete(tunnelId);

    log.info({ tunnelId, motd: result.motd, players: result.onlinePlayers }, 'MOTD check succeeded');

    const message = [
      `Minecraft 服务器已就绪 (${tunnelId})`,
      `MOTD: ${result.motd}`,
      `在线人数: ${result.onlinePlayers}/${result.maxPlayers}`,
      `版本: ${result.version}`,
      `连接地址: ${entry.host}:${entry.port}`,
      '',
      getMessageHeader(),
    ].join('\n');

    const bot = await getBot();
    await bot.sendGroupMessage(entry.groupId, entry.userId, message);
  } catch (err) {
    log.debug({ tunnelId, err: (err as Error).message, isLast }, 'MOTD check failed');

    if (isLast) {
      // All checks exhausted — send failure notification
      entry.resolved = true;
      pendingChecks.delete(tunnelId);

      log.warn({ tunnelId }, 'All MOTD checks failed');

      const message = [
        `Minecraft 服务器状态检测失败 (${tunnelId})`,
        `在 10 分钟内未检测到服务器 MOTD 响应。`,
        `请确认 MC 服务端已启动并绑定到正确端口。`,
        `连接地址: ${entry.host}:${entry.port}`,
        '',
        getMessageHeader(),
      ].join('\n');

      try {
        const bot = await getBot();
        await bot.sendGroupMessage(entry.groupId, entry.userId, message);
      } catch (e) {
        log.error({ err: e, tunnelId }, 'Failed to send MOTD failure notification');
      }
    }
  }
}

/**
 * Query MOTD for a single server (for the "列表" command).
 * Returns null if the server is unreachable.
 */
export async function queryMotd(host: string, port: number): Promise<McPingResult | null> {
  try {
    return await mcPing(host, port, 5000);
  } catch {
    return null;
  }
}
