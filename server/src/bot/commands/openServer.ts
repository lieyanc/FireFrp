import * as keyService from '../../services/keyService';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getMessageHeader } from '../../version';

const log = logger.child({ module: 'bot:openServer' });

/**
 * Game type aliases mapping to canonical names.
 * SECURITY: This serves as a strict whitelist. Only these game types are allowed.
 */
const GAME_ALIASES: Record<string, string> = {
  mc: 'minecraft',
  minecraft: 'minecraft',
  terraria: 'terraria',
  tr: 'terraria',
  dst: 'dont_starve_together',
  starbound: 'starbound',
  factorio: 'factorio',
  valheim: 'valheim',
  palworld: 'palworld',
};

/**
 * Display names for game types (properly cased for user-facing output).
 */
const GAME_DISPLAY_NAMES: Record<string, string> = {
  minecraft: 'Minecraft Java(默认)',
  terraria: 'Terraria',
  dont_starve_together: "Don't Starve Together",
  starbound: 'Starbound',
  factorio: 'Factorio',
  valheim: 'Valheim',
  palworld: 'Palworld',
};

/**
 * Get the display name for a game type canonical name.
 */
export function getGameDisplayName(gameType: string): string {
  return GAME_DISPLAY_NAMES[gameType] ?? gameType;
}

/**
 * Set of all valid canonical game type names (for whitelist validation).
 */
const VALID_GAME_TYPES = new Set(Object.values(GAME_ALIASES));

/**
 * Rate limit: per group, per hour.
 * Map<groupId, { count: number, resetAt: number }>
 */
const groupRateLimit = new Map<string, { count: number; resetAt: number }>();

const MAX_ACTIVE_KEYS_PER_USER = 3;
const MAX_GROUP_REQUESTS_PER_HOUR = 10;
const MIN_TTL_MINUTES = 5;

/**
 * Handle the "open server" command.
 *
 * @param userId - The user's unique identifier
 * @param userName - The user's display name
 * @param groupId - The group/channel identifier
 * @param args - Command arguments: [gameType?, ttlMinutes?]
 * @returns Response message string
 */
export function handleOpenServer(
  userId: string,
  userName: string,
  groupId: string,
  args: string[],
): string {
  // Parse game type (strict whitelist validation)
  const rawGameType = args[0] ?? 'minecraft';
  const gameType = GAME_ALIASES[rawGameType.toLowerCase()];

  // SECURITY: reject unknown game types instead of allowing arbitrary strings
  if (!gameType) {
    const validTypes = [...new Set(Object.values(GAME_ALIASES))].map(t => getGameDisplayName(t)).join(', ');
    return `不支持的游戏类型: "${rawGameType}"\n支持的类型: ${validTypes}`;
  }

  // Parse TTL (user can set up to the configured max)
  const maxTtl = config.keyTtlMinutes;
  let ttlMinutes = maxTtl;
  if (args[1]) {
    const parsed = parseInt(args[1], 10);
    if (Number.isNaN(parsed) || parsed < MIN_TTL_MINUTES || parsed > maxTtl) {
      return `时长参数无效，请输入 ${MIN_TTL_MINUTES}-${maxTtl} 之间的分钟数`;
    }
    ttlMinutes = parsed;
  }

  // Check per-user active key limit
  const activeKeys = keyService.getActiveByUser(userId);
  if (activeKeys.length >= MAX_ACTIVE_KEYS_PER_USER) {
    return `你已经有 ${activeKeys.length} 个活跃的隧道，最多同时 ${MAX_ACTIVE_KEYS_PER_USER} 个。请等待现有隧道过期或使用"状态"查看详情。`;
  }

  // Check per-group rate limit
  const now = Date.now();
  let groupLimit = groupRateLimit.get(groupId);
  if (!groupLimit || now >= groupLimit.resetAt) {
    groupLimit = { count: 0, resetAt: now + 60 * 60 * 1000 };
    groupRateLimit.set(groupId, groupLimit);
  }
  if (groupLimit.count >= MAX_GROUP_REQUESTS_PER_HOUR) {
    return `本群本小时开服次数已达上限 (${MAX_GROUP_REQUESTS_PER_HOUR} 次)，请稍后再试。`;
  }
  groupLimit.count++;

  // Create the key
  try {
    const accessKey = keyService.create(userId, userName, gameType, ttlMinutes, groupId);

    log.info(
      { keyId: accessKey.id, userId, gameType, ttlMinutes, groupId },
      'Open server command executed',
    );

    return [
      `隧道创建成功! 游戏: ${getGameDisplayName(gameType)}`,
      ``,
      `隧道编号: ${accessKey.tunnelId}`,
      `Access Key: ${accessKey.key}`,
      `远程端口: ${accessKey.remotePort}`,
      `有效时间: ${ttlMinutes} 分钟`,
      `过期时间: ${accessKey.expiresAt}`,
      ``,
      `请在 FireFrp 客户端中输入此 Key 来建立隧道。`,
      ``,
      getMessageHeader(),
    ].join('\n');
  } catch (err) {
    log.error({ err, userId, gameType }, 'Failed to create access key');
    return '开服失败，请稍后重试或联系管理员。';
  }
}
