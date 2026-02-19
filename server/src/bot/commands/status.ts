import * as keyService from '../../services/keyService';
import { frpManager } from '../../services/frpManager';
import { logger } from '../../utils/logger';

const log = logger.child({ module: 'bot:status' });

/**
 * Handle the "status" command.
 * Shows the user's currently active tunnels and server status.
 *
 * @param userId - The user's unique identifier
 * @returns Response message string
 */
export function handleStatus(userId: string): string {
  const activeKeys = keyService.getActiveByUser(userId);
  const frpsStatus = frpManager.getStatus();

  const lines: string[] = [];

  lines.push('--- FireFrp 状态 ---');
  lines.push('');

  // Server status
  lines.push(`frps 状态: ${frpsStatus.state}`);
  if (frpsStatus.uptime !== null) {
    const hours = Math.floor(frpsStatus.uptime / 3600);
    const minutes = Math.floor((frpsStatus.uptime % 3600) / 60);
    lines.push(`运行时间: ${hours}小时${minutes}分钟`);
  }
  lines.push(`frp 版本: v${frpsStatus.version}`);
  lines.push('');

  // User's active tunnels
  if (activeKeys.length === 0) {
    lines.push('你当前没有活跃的隧道。');
    lines.push('使用"@Bot 开服 [游戏类型]"来创建一个。');
  } else {
    lines.push(`你的活跃隧道 (${activeKeys.length} 个):`);
    lines.push('');

    for (const key of activeKeys) {
      const expiresAt = new Date(key.expiresAt);
      const remaining = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 60000));

      lines.push(`  [${key.status === 'active' ? '已连接' : '待连接'}] ${key.gameType}`);
      lines.push(`    Key: ${key.key.slice(0, 12)}...`);
      lines.push(`    端口: ${key.remotePort}`);
      lines.push(`    剩余: ${remaining} 分钟`);
      lines.push('');
    }
  }

  log.debug({ userId, activeKeyCount: activeKeys.length }, 'Status command executed');

  return lines.join('\n');
}
