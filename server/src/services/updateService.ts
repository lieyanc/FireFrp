/**
 * Server OTA update service.
 * Downloads the latest release from GitHub, replaces server files, and exits
 * so the external process manager can restart with the new version.
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import fetch from 'node-fetch';
import { config } from '../config';
import { getVersion } from '../version';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'updateService' });

const GITHUB_REPO = 'lieyanc/FireFrp';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string | null;
  tag: string;
}

/**
 * Determine whether to look for dev (pre-release) builds.
 * Uses config.updates.channel when explicitly set, otherwise
 * falls back to version-string-based detection.
 */
function shouldCheckDev(): boolean {
  const channel = config.updates.channel;
  if (channel === 'dev') return true;
  if (channel === 'stable') return false;
  // "auto": detect from current version string
  return getVersion().startsWith('dev-');
}

/**
 * Check GitHub Releases for a newer version.
 * Uses config.updates.channel to determine which releases to check.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = getVersion();
  const isDev = shouldCheckDev();

  const result: UpdateCheckResult = {
    available: false,
    currentVersion,
    latestVersion: currentVersion,
    downloadUrl: null,
    tag: '',
  };

  try {
    const resp = await fetch(GITHUB_API, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      timeout: 15000,
    });

    if (!resp.ok) {
      log.error({ status: resp.status }, 'Failed to fetch GitHub releases');
      return result;
    }

    const releases = (await resp.json()) as any[];

    // Find the appropriate release
    const target = releases.find((r: any) =>
      isDev ? r.prerelease === true : r.prerelease === false
    );

    if (!target) {
      log.info('No matching release found on GitHub');
      return result;
    }

    // Extract version from tag
    const tag = target.tag_name as string;
    const latestVersion = isDev ? tag : tag.replace(/^v/, '');

    if (latestVersion === currentVersion) {
      log.info({ currentVersion }, 'Already on the latest version');
      return result;
    }

    // Find the server tarball asset
    const asset = (target.assets as any[]).find(
      (a: any) => a.name === 'firefrp-server.tar.gz'
    );

    if (!asset) {
      log.warn({ tag }, 'No firefrp-server.tar.gz asset found in release');
      return result;
    }

    result.available = true;
    result.latestVersion = latestVersion;
    result.downloadUrl = asset.browser_download_url;
    result.tag = tag;
  } catch (err) {
    log.error({ err }, 'Error checking for updates');
  }

  return result;
}

/**
 * Download and apply the server update.
 * Replaces dist/, node_modules/, package.json, version.json.
 * Preserves config.json, data/, bin/.
 * Exits the process after completion for the process manager to restart.
 */
export async function performUpdate(info?: UpdateCheckResult): Promise<void> {
  if (!info) {
    info = await checkForUpdate();
  }

  if (!info.available || !info.downloadUrl) {
    log.info('No update available');
    return;
  }

  const serverRoot = config.paths.root;
  log.info(
    { from: info.currentVersion, to: info.latestVersion, tag: info.tag },
    'Starting server update',
  );

  // Download the tarball
  const resp = await fetch(info.downloadUrl, { timeout: 120000 });
  if (!resp.ok) {
    throw new Error(`Failed to download update: ${resp.status} ${resp.statusText}`);
  }

  const buffer = await resp.buffer();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefrp-update-'));
  const archivePath = path.join(tmpDir, 'firefrp-server.tar.gz');

  fs.writeFileSync(archivePath, buffer);
  log.info({ size: buffer.length }, 'Update archive downloaded');

  // Extract
  childProcess.execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { timeout: 60000 });
  log.info('Archive extracted');

  // Replace files (preserve config.json, data/, bin/)
  const filesToReplace = ['dist', 'node_modules', 'package.json', 'version.json'];

  for (const name of filesToReplace) {
    const src = path.join(tmpDir, name);
    const dest = path.join(serverRoot, name);

    if (!fs.existsSync(src)) {
      log.warn({ name }, 'Expected file/dir not found in update archive, skipping');
      continue;
    }

    // Remove existing
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }

    // Move new into place
    fs.renameSync(src, dest);
    log.info({ name }, 'Replaced');
  }

  // Clean up temp directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }

  // Write update marker so the next startup can broadcast the update notification
  try {
    const dataDir = config.paths.data;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(path.join(dataDir, '.just_updated'), info.latestVersion);
  } catch {
    // non-critical, ignore
  }

  log.info(
    { version: info.latestVersion },
    'Server update complete, exiting for restart',
  );

  process.exit(0);
}
