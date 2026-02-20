import * as keyService from '../../services/keyService';
import { config } from '../../config';
import { queryMotd } from '../../services/motdCheckService';
import { getGameDisplayName } from './openServer';
import { logger } from '../../utils/logger';
import { getMessageHeader } from '../../version';

const log = logger.child({ module: 'bot:list' });

/**
 * Handle the "列表" / "list" command.
 * Lists all active/pending tunnels in the current group.
 * For active Minecraft tunnels, performs a real-time MOTD query.
 *
 * @param groupId - The group where the command was issued
 * @returns Response message string
 */
export async function handleList(groupId: string): Promise<string> {
  const tunnels = keyService.getActiveByGroup(groupId);

  if (tunnels.length === 0) {
    return '本群当前没有活跃的隧道。';
  }

  const lines: string[] = [];
  lines.push(`--- 本群隧道列表 (${tunnels.length} 个) ---`);
  lines.push('');

  for (const tunnel of tunnels) {
    const expiresAt = new Date(tunnel.expiresAt);
    const remaining = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 60000));
    const status = tunnel.status === 'active' ? '已连接' : '待连接';
    const addr = `${config.server.publicAddr}:${tunnel.remotePort}`;

    lines.push(`[${status}] ${getGameDisplayName(tunnel.gameType)} - ${tunnel.userName}`);
    lines.push(`  隧道: ${tunnel.tunnelId} | 地址: ${addr}`);
    lines.push(`  剩余: ${remaining} 分钟`);

    // For active MC tunnels, query MOTD in real time
    if (tunnel.status === 'active' && tunnel.gameType === 'minecraft') {
      const motd = await queryMotd(config.server.publicAddr, tunnel.remotePort);
      if (motd) {
        lines.push(`  MOTD: ${motd.motd}`);
        lines.push(`  在线: ${motd.onlinePlayers}/${motd.maxPlayers} | 版本: ${motd.version}`);
      } else {
        lines.push(`  (MC 服务器未响应 MOTD)`);
      }
    }

    lines.push('');
  }

  log.debug({ groupId, tunnelCount: tunnels.length }, 'List command executed');

  lines.push(getMessageHeader());

  return lines.join('\n');
}
