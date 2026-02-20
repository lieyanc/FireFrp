/**
 * Admin command: 通道 / channel
 * View or change the update channel (auto / dev / stable).
 */

import { config, saveConfig } from '../../config';
import { getVersion } from '../../version';

const VALID_CHANNELS = ['auto', 'dev', 'stable'] as const;

export function handleChannel(args: string[]): string {
  if (args.length === 0) {
    // Show current channel
    const ch = config.updates.channel;
    const ver = getVersion();
    return (
      `当前更新通道: ${ch}\n` +
      `当前版本: ${ver}\n` +
      `可选: auto | dev | stable`
    );
  }

  const target = args[0].toLowerCase();
  if (!VALID_CHANNELS.includes(target as any)) {
    return `无效通道 "${args[0]}"，可选: auto | dev | stable`;
  }

  (config.updates as { channel: string }).channel = target;
  saveConfig();

  return `更新通道已切换为: ${target}`;
}
