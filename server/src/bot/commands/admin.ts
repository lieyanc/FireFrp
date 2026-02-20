import * as keyService from '../../services/keyService';
import * as frpsService from '../../services/frpsService';
import { frpManager } from '../../services/frpManager';
import { addToRejectSet } from '../../services/expiryService';
import { config, saveConfig } from '../../config';
import { logger } from '../../utils/logger';
import { getGameDisplayName } from './openServer';
import { getDisplayVersion } from '../../version';

const log = logger.child({ module: 'bot:admin' });

/**
 * Handle "隧道列表" / "tunnels" command.
 * Shows all pending/active tunnels.
 */
export function handleTunnels(): string {
  const keys = keyService.getAllActive();

  if (keys.length === 0) {
    return '当前没有活跃的隧道。';
  }

  const lines: string[] = [];
  lines.push(`--- 活跃隧道 (${keys.length} 个) | ${getDisplayVersion()} ---`);
  lines.push('');

  for (const key of keys) {
    const expiresAt = new Date(key.expiresAt);
    const remaining = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 60000));
    const status = key.status === 'active' ? '已连接' : '待连接';

    lines.push(`[${key.tunnelId}] ${status} | ${getGameDisplayName(key.gameType)} | ${key.userName}`);
    lines.push(`  端口: ${key.remotePort} | 剩余: ${remaining}分钟`);
  }

  return lines.join('\n');
}

/**
 * Handle "踢掉" / "kick" command.
 * Revokes a key by tunnel ID, disconnecting the client.
 */
export function handleKick(args: string[]): string {
  if (args.length === 0) {
    return '用法: 踢掉 <隧道ID>\n使用"隧道列表"查看可用 ID。';
  }

  const tunnelId = args[0];
  const record = keyService.getByTunnelId(tunnelId);
  if (!record) {
    return `未找到隧道 ${tunnelId}。`;
  }

  const revoked = keyService.revoke(record.id);
  if (!revoked) {
    return `隧道 ${tunnelId} 不是活跃状态，无法撤销。`;
  }

  // Add to reject set so frps Ping will disconnect the client
  addToRejectSet(revoked.key);

  log.info({ tunnelId, userId: revoked.userId, proxyName: revoked.proxyName }, 'Admin kicked tunnel');

  return [
    `已撤销隧道 [${tunnelId}]`,
    `  用户: ${revoked.userName}`,
    `  游戏: ${getGameDisplayName(revoked.gameType)}`,
    `  端口: ${revoked.remotePort}`,
    '客户端将在下次心跳时被断开。',
  ].join('\n');
}

/**
 * Handle "加群" / "addgroup" command.
 * Adds a group to the allowed groups whitelist.
 */
export function handleAddGroup(args: string[]): string {
  if (args.length === 0) {
    return '用法: 加群 <群号>';
  }

  const groupId = parseInt(args[0], 10);
  if (Number.isNaN(groupId) || groupId <= 0) {
    return `无效的群号: "${args[0]}"`;
  }

  const allowed = config.bot.allowedGroups;
  if (allowed.includes(groupId)) {
    return `群 ${groupId} 已在白名单中。`;
  }

  allowed.push(groupId);

  try {
    saveConfig();
  } catch (err) {
    // Rollback
    allowed.pop();
    log.error({ err }, 'Failed to save config after addgroup');
    return '保存配置失败，请检查服务器日志。';
  }

  log.info({ groupId }, 'Admin added group to whitelist');
  return `已将群 ${groupId} 加入白名单。`;
}

/**
 * Handle "移群" / "rmgroup" command.
 * Removes a group from the allowed groups whitelist.
 */
export function handleRmGroup(args: string[]): string {
  if (args.length === 0) {
    return '用法: 移群 <群号>';
  }

  const groupId = parseInt(args[0], 10);
  if (Number.isNaN(groupId) || groupId <= 0) {
    return `无效的群号: "${args[0]}"`;
  }

  const allowed = config.bot.allowedGroups;
  const index = allowed.indexOf(groupId);
  if (index === -1) {
    return `群 ${groupId} 不在白名单中。`;
  }

  allowed.splice(index, 1);

  try {
    saveConfig();
  } catch (err) {
    // Rollback
    allowed.splice(index, 0, groupId);
    log.error({ err }, 'Failed to save config after rmgroup');
    return '保存配置失败，请检查服务器日志。';
  }

  log.info({ groupId }, 'Admin removed group from whitelist');
  return `已将群 ${groupId} 从白名单移除。`;
}

/**
 * Handle "群列表" / "groups" command.
 * Shows the current allowed groups whitelist.
 */
export function handleGroups(): string {
  const allowed = config.bot.allowedGroups;

  if (allowed.length === 0) {
    return '未设置群白名单（所有群均可使用）。\n使用"加群 <群号>"添加白名单。';
  }

  const lines: string[] = [];
  lines.push(`--- 群白名单 (${allowed.length} 个) ---`);
  for (const g of allowed) {
    lines.push(`  ${g}`);
  }
  lines.push('');
  lines.push('使用"加群/移群 <群号>"管理白名单。');

  return lines.join('\n');
}

/**
 * Handle "服务器" / "server" command.
 * Shows detailed frps server status.
 */
export async function handleServerStatus(): Promise<string> {
  const managerStatus = frpManager.getStatus();
  const lines: string[] = [];

  lines.push('--- 服务器状态 ---');
  lines.push('');
  lines.push(`FireFrp 版本: ${getDisplayVersion()}`);
  lines.push(`frps 状态: ${managerStatus.state}`);

  if (managerStatus.uptime !== null) {
    const hours = Math.floor(managerStatus.uptime / 3600);
    const minutes = Math.floor((managerStatus.uptime % 3600) / 60);
    lines.push(`运行时间: ${hours}小时${minutes}分钟`);
  }

  lines.push(`frp 版本: v${managerStatus.version}`);
  lines.push(`重启次数: ${managerStatus.restartCount}`);

  // Try to get detailed info from frps admin API
  if (managerStatus.state === 'running') {
    try {
      const info = await frpsService.getServerInfo();
      lines.push('');
      lines.push(`当前连接数: ${info.curConns}`);
      lines.push(`客户端数: ${info.clientCounts}`);

      const tcpCount = info.proxyTypeCounts?.tcp ?? 0;
      lines.push(`TCP 代理数: ${tcpCount}`);

      const inMB = (info.totalTrafficIn / 1024 / 1024).toFixed(2);
      const outMB = (info.totalTrafficOut / 1024 / 1024).toFixed(2);
      lines.push(`总流量: 入 ${inMB} MB / 出 ${outMB} MB`);
    } catch (err) {
      lines.push('');
      lines.push('(无法获取 frps 详细信息)');
      log.error({ err }, 'Failed to fetch frps server info for admin command');
    }
  }

  // Active tunnels summary
  const activeKeys = keyService.getAllActive();
  lines.push('');
  lines.push(`活跃隧道: ${activeKeys.filter(k => k.status === 'active').length} 个`);
  lines.push(`待连接: ${activeKeys.filter(k => k.status === 'pending').length} 个`);

  return lines.join('\n');
}
