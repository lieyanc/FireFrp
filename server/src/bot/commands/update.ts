/**
 * Admin command: 更新 / update
 * Checks for a new server version on GitHub and applies the update.
 */

import { checkForUpdate, performUpdate } from '../../services/updateService';
import { logger } from '../../utils/logger';

const log = logger.child({ module: 'cmd:update' });

export async function handleUpdate(): Promise<string> {
  try {
    const info = await checkForUpdate();

    if (!info.available) {
      return `已是最新版本 (当前: ${info.currentVersion})`;
    }

    // Notify before starting the update (this message goes out first)
    const msg =
      `发现新版本: ${info.latestVersion}\n` +
      `当前版本: ${info.currentVersion}\n` +
      `正在更新，即将重启...`;

    // Start the update in the background so the reply can be sent first
    setTimeout(() => {
      performUpdate(info).catch((err) => {
        log.error({ err }, 'Update failed');
      });
    }, 1000);

    return msg;
  } catch (err) {
    log.error({ err }, 'Update check failed');
    return `检查更新失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}
