/**
 * Admin command: 更新 / update
 * Checks for a new server version on GitHub and applies the update.
 *
 * Returns an immediate acknowledgment string. The actual update check
 * and download run in the background, sending progress via the provided
 * callback so the user gets real-time status in the group chat.
 */

import { checkForUpdate, performUpdate } from '../../services/updateService';
import { logger } from '../../utils/logger';
import { getMessageHeader } from '../../version';

const log = logger.child({ module: 'cmd:update' });

const CHECK_TIMEOUT_MS = 20_000;

/**
 * Start the update flow.
 *
 * @param sendProgress - Async callback that sends a follow-up message to the
 *   same group/user. The caller (qqBot) provides this.
 * @returns An immediate reply string ("正在检查更新...").
 */
export function handleUpdate(sendProgress: (text: string) => Promise<void>): string {
  // Fire-and-forget: run the async update flow in the background.
  (async () => {
    try {
      log.info('Checking for updates on GitHub...');

      // Race against a timeout to avoid hanging forever.
      const info = await Promise.race([
        checkForUpdate(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('检查更新超时 (GitHub API 无响应)')), CHECK_TIMEOUT_MS),
        ),
      ]);

      log.info(
        { available: info.available, current: info.currentVersion, latest: info.latestVersion },
        'Update check complete',
      );

      if (!info.available) {
        await sendProgress(`${getMessageHeader()}\n已是最新版本 (${info.currentVersion})`);
        return;
      }

      await sendProgress(
        `${getMessageHeader()}\n` +
        `发现新版本: ${info.latestVersion}\n` +
        `当前版本: ${info.currentVersion}\n` +
        `正在下载更新包...`,
      );

      // performUpdate downloads, replaces files, then calls process.exit(0).
      await performUpdate(info);
    } catch (err) {
      log.error({ err }, 'Update failed');
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendProgress(`${getMessageHeader()}\n更新失败: ${errMsg}`).catch(() => {});
    }
  })();

  return `${getMessageHeader()}\n正在检查更新...`;
}
