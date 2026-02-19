import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import fetch from 'node-fetch';
import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'frpManager' });

type FrpState = 'stopped' | 'starting' | 'running' | 'error';

export interface FrpManagerStatus {
  state: FrpState;
  pid: number | null;
  uptime: number | null;
  version: string;
  restartCount: number;
}

class FrpManager {
  private frpsProcess: childProcess.ChildProcess | null = null;
  private state: FrpState = 'stopped';
  private startedAt: number | null = null;
  private restartCount: number = 0;
  private restartDelay: number = 1000; // ms, exponential backoff
  private intentionalStop: boolean = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Binary management ───────────────────────────────────────────────

  private get binDir(): string {
    return config.paths.bin;
  }

  private get frpsPath(): string {
    const ext = os.platform() === 'win32' ? '.exe' : '';
    return path.join(this.binDir, `frps${ext}`);
  }

  private get configPath(): string {
    return path.join(config.paths.data, 'frps.toml');
  }

  /**
   * Detect the current OS and architecture for frp download URL.
   */
  private detectPlatform(): { osName: string; arch: string; ext: string } {
    const platform = os.platform();
    const cpuArch = os.arch();

    let osName: string;
    switch (platform) {
      case 'linux':
        osName = 'linux';
        break;
      case 'darwin':
        osName = 'darwin';
        break;
      case 'win32':
        osName = 'windows';
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }

    let arch: string;
    switch (cpuArch) {
      case 'x64':
        arch = 'amd64';
        break;
      case 'arm64':
        arch = 'arm64';
        break;
      default:
        throw new Error(`Unsupported architecture: ${cpuArch}`);
    }

    const ext = osName === 'windows' ? 'zip' : 'tar.gz';

    return { osName, arch, ext };
  }

  /**
   * Ensure the frps binary exists and matches the required version.
   * Downloads and extracts if necessary.
   */
  async ensureBinary(): Promise<string> {
    // Create bin directory if needed
    if (!fs.existsSync(this.binDir)) {
      fs.mkdirSync(this.binDir, { recursive: true });
    }

    // Check if binary exists
    if (fs.existsSync(this.frpsPath)) {
      // Verify version
      try {
        const versionOutput = childProcess.execSync(`"${this.frpsPath}" --version`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
        if (versionOutput === config.frpVersion || versionOutput.includes(config.frpVersion)) {
          log.info({ version: versionOutput, path: this.frpsPath }, 'frps binary version verified');
          return this.frpsPath;
        }
        log.warn({ expected: config.frpVersion, found: versionOutput }, 'frps version mismatch, re-downloading');
      } catch (err) {
        log.warn({ err }, 'Failed to verify frps version, re-downloading');
      }
    }

    await this.downloadBinary();
    return this.frpsPath;
  }

  /**
   * Download and extract the frps binary from GitHub Releases.
   */
  private async downloadBinary(): Promise<void> {
    const { osName, arch, ext } = this.detectPlatform();
    const version = config.frpVersion;
    const archiveName = `frp_${version}_${osName}_${arch}`;
    const fileName = `${archiveName}.${ext}`;
    const url = `https://github.com/fatedier/frp/releases/download/v${version}/${fileName}`;

    log.info({ url }, 'Downloading frps binary');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download frps: ${response.status} ${response.statusText} from ${url}`);
    }

    const buffer = await response.buffer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frps-'));
    const archivePath = path.join(tmpDir, fileName);

    fs.writeFileSync(archivePath, buffer);
    log.info({ archivePath, size: buffer.length }, 'Archive downloaded');

    // Extract binary
    const frpsBinaryName = osName === 'windows' ? 'frps.exe' : 'frps';

    if (ext === 'tar.gz') {
      childProcess.execSync(
        `tar -xzf "${archivePath}" -C "${tmpDir}"`,
        { timeout: 30000 },
      );
      const extractedBinary = path.join(tmpDir, archiveName, frpsBinaryName);
      if (!fs.existsSync(extractedBinary)) {
        throw new Error(`frps binary not found in archive at ${extractedBinary}`);
      }
      fs.copyFileSync(extractedBinary, this.frpsPath);
    } else {
      // zip (Windows)
      childProcess.execSync(
        `unzip -o "${archivePath}" -d "${tmpDir}"`,
        { timeout: 30000 },
      );
      const extractedBinary = path.join(tmpDir, archiveName, frpsBinaryName);
      if (!fs.existsSync(extractedBinary)) {
        throw new Error(`frps binary not found in archive at ${extractedBinary}`);
      }
      fs.copyFileSync(extractedBinary, this.frpsPath);
    }

    // Make executable (non-Windows)
    if (osName !== 'windows') {
      fs.chmodSync(this.frpsPath, 0o755);
    }

    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }

    log.info({ path: this.frpsPath }, 'frps binary installed');
  }

  // ─── Config generation ───────────────────────────────────────────────

  /**
   * Escape a string for use in a TOML double-quoted value.
   * Handles backslashes, double quotes, and newlines.
   */
  private escapeToml(s: string): string {
    return s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  /**
   * Generate frps.toml content from the current configuration.
   */
  generateConfig(): string {
    const c = config.frps;
    const esc = (s: string) => this.escapeToml(s);
    const lines = [
      '# Generated by FrpManager - do not edit manually',
      `bindAddr = "${esc(c.bindAddr)}"`,
      `bindPort = ${c.bindPort}`,
      '',
      '[auth]',
      'method = "token"',
      `token = "${esc(c.authToken)}"`,
      '',
      '[webServer]',
      `addr = "${esc(c.adminAddr)}"`,
      `port = ${c.adminPort}`,
      `user = "${esc(c.adminUser)}"`,
      `password = "${esc(c.adminPassword)}"`,
      '',
      `allowPorts = [{ start = ${config.portRangeStart}, end = ${config.portRangeEnd} }]`,
      'maxPortsPerClient = 1',
      '',
      '[[httpPlugins]]',
      'name = "firefrp-manager"',
      `addr = "127.0.0.1:${config.serverPort}"`,
      'path = "/frps-plugin/handler"',
      'ops = ["Login", "NewProxy", "CloseProxy", "Ping"]',
    ];

    return lines.join('\n') + '\n';
  }

  // ─── Process management ──────────────────────────────────────────────

  /**
   * Start frps: ensure binary, generate config, spawn process, wait for admin API.
   */
  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      log.warn({ state: this.state }, 'frps is already running or starting');
      return;
    }

    this.state = 'starting';
    this.intentionalStop = false;

    try {
      // Ensure binary
      const binaryPath = await this.ensureBinary();

      // Generate and write config (with restrictive permissions since it contains secrets)
      const configContent = this.generateConfig();
      if (!fs.existsSync(config.paths.data)) {
        fs.mkdirSync(config.paths.data, { recursive: true });
      }
      fs.writeFileSync(this.configPath, configContent, { encoding: 'utf-8', mode: 0o600 });
      log.info({ configPath: this.configPath }, 'frps config written');

      // Spawn process
      this.frpsProcess = childProcess.spawn(binaryPath, ['-c', this.configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Pipe stdout
      if (this.frpsProcess.stdout) {
        this.frpsProcess.stdout.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) log.info({ source: 'frps:stdout' }, msg);
        });
      }

      // Pipe stderr
      if (this.frpsProcess.stderr) {
        this.frpsProcess.stderr.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) log.warn({ source: 'frps:stderr' }, msg);
        });
      }

      // Handle exit
      this.frpsProcess.on('exit', (code, signal) => {
        log.warn({ code, signal, intentional: this.intentionalStop }, 'frps process exited');
        this.frpsProcess = null;

        if (this.intentionalStop) {
          this.state = 'stopped';
          this.startedAt = null;
          return;
        }

        // Unexpected exit — schedule restart with exponential backoff
        this.state = 'error';
        this.startedAt = null;
        this.restartCount++;
        const delay = Math.min(this.restartDelay * Math.pow(2, this.restartCount - 1), 30000);
        log.info({ restartCount: this.restartCount, delayMs: delay }, 'Scheduling frps restart');

        this.restartTimer = setTimeout(() => {
          this.start().catch((err) => {
            log.error({ err }, 'Failed to restart frps');
          });
        }, delay);
      });

      this.frpsProcess.on('error', (err) => {
        log.error({ err }, 'frps process error');
        this.state = 'error';
      });

      // Wait for admin API to be reachable
      await this.waitForAdminApi();

      this.state = 'running';
      this.startedAt = Date.now();
      this.restartDelay = 1000; // Reset backoff on successful start
      log.info({ pid: this.frpsProcess?.pid }, 'frps started successfully');
    } catch (err) {
      this.state = 'error';
      log.error({ err }, 'Failed to start frps');
      throw err;
    }
  }

  /**
   * Wait for the frps admin API to become reachable.
   */
  private async waitForAdminApi(maxAttempts: number = 30, intervalMs: number = 1000): Promise<void> {
    const { adminAddr, adminPort, adminUser, adminPassword } = config.frps;
    const url = `http://${adminAddr}:${adminPort}/api/serverinfo`;
    const auth = Buffer.from(`${adminUser}:${adminPassword}`).toString('base64');

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const resp = await fetch(url, {
          headers: { Authorization: `Basic ${auth}` },
          timeout: 2000,
        });
        if (resp.ok) {
          log.info('frps admin API is reachable');
          return;
        }
      } catch {
        // Not yet ready
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`frps admin API not reachable after ${maxAttempts} attempts`);
  }

  /**
   * Stop the frps process gracefully.
   */
  async stop(): Promise<void> {
    // Cancel any pending restart
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.frpsProcess) {
      this.state = 'stopped';
      return;
    }

    this.intentionalStop = true;

    return new Promise<void>((resolve) => {
      const proc = this.frpsProcess!;
      let killed = false;

      const forceKillTimer = setTimeout(() => {
        if (!killed && proc.pid) {
          log.warn('frps did not exit gracefully, sending SIGKILL');
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 10000);

      proc.on('exit', () => {
        killed = true;
        clearTimeout(forceKillTimer);
        this.frpsProcess = null;
        this.state = 'stopped';
        this.startedAt = null;
        log.info('frps stopped');
        resolve();
      });

      // Send SIGTERM
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be dead
        killed = true;
        clearTimeout(forceKillTimer);
        this.frpsProcess = null;
        this.state = 'stopped';
        this.startedAt = null;
        resolve();
      }
    });
  }

  /**
   * Restart frps: stop then start.
   */
  async restart(): Promise<void> {
    log.info('Restarting frps');
    await this.stop();
    await this.start();
  }

  /**
   * Get the current frps manager status.
   */
  getStatus(): FrpManagerStatus {
    return {
      state: this.state,
      pid: this.frpsProcess?.pid ?? null,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : null,
      version: config.frpVersion,
      restartCount: this.restartCount,
    };
  }
}

// Singleton instance
export const frpManager = new FrpManager();
