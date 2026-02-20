import express from 'express';
import * as http from 'http';
import { config } from './config';
import { logger } from './utils/logger';
import { accessKeyStore } from './db/models/accessKey';
import { auditLogStore } from './db/models/auditLog';
import { apiRouter } from './api/router';
import { errorHandler } from './middleware/errorHandler';
import { frpManager } from './services/frpManager';
import { checkForUpdate, performUpdate } from './services/updateService';
import * as expiryService from './services/expiryService';
import { stopRateLimitCleanup } from './api/clientRoutes';
import { qqBot } from './bot/qqBot';
import { getDisplayVersion, getVersion } from './version';
import { cancelAll as cancelAllMotdChecks } from './services/motdCheckService';
import * as fs from 'fs';
import * as path from 'path';

const log = logger.child({ module: 'main' });

// ── Handle --update CLI flag ──
if (process.argv.includes('--update')) {
  (async () => {
    log.info('Running in update mode');
    const info = await checkForUpdate();
    if (info.available) {
      log.info({ from: info.currentVersion, to: info.latestVersion }, 'Update available');
      await performUpdate(info);
    } else {
      log.info({ version: info.currentVersion }, 'Already on the latest version');
      process.exit(0);
    }
  })().catch((err) => {
    log.fatal({ err }, 'Update failed');
    process.exit(1);
  });
} else {
  main().catch((err) => {
    log.fatal({ err }, 'Fatal error during startup');
    process.exit(1);
  });
}

async function main(): Promise<void> {
  log.info('FireFrp Server starting...');

  // ── Step 1: Load configuration ──
  log.info(
    {
      serverPort: config.serverPort,
      frpVersion: config.frpVersion,
      bindPort: config.frps.bindPort,
      adminPort: config.frps.adminPort,
      portRange: `${config.portRangeStart}-${config.portRangeEnd}`,
    },
    'Configuration loaded',
  );

  // ── Step 2: Initialize JSON Stores ──
  // Ensure data directory exists
  if (!fs.existsSync(config.paths.data)) {
    fs.mkdirSync(config.paths.data, { recursive: true });
    log.info({ dir: config.paths.data }, 'Created data directory');
  }

  accessKeyStore.load();
  auditLogStore.load();
  log.info('JSON stores initialized');

  // ── Step 3: Start Express API ──
  // This must start before frps, because frps will call back to our plugin handler
  const app = express();

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Request logging
  app.use((req, _res, next) => {
    log.debug({ method: req.method, url: req.url }, 'Request');
    next();
  });

  // Routes
  app.use(apiRouter);

  // Global error handler (must be last middleware)
  app.use(errorHandler);

  const httpServer = await new Promise<http.Server>((resolve) => {
    const server = app.listen(config.serverPort, () => {
      log.info({ port: config.serverPort }, 'Express API server started');
      resolve(server);
    });
  });

  // ── Step 4: Start frps via FrpManager ──
  log.info('Starting frps process manager...');
  try {
    await frpManager.start();
    const status = frpManager.getStatus();
    log.info({ status }, 'frps is running');
  } catch (err) {
    log.error({ err }, 'Failed to start frps — server will continue without frps');
    // Don't exit: the API can still serve requests, and frpManager will auto-retry
  }

  // ── Step 5: frps admin API is reachable (verified inside frpManager.start) ──

  // ── Step 6: Start expiry service ──
  expiryService.start();
  log.info('Expiry service started');

  // ── Step 7: Start QQ Bot ──
  try {
    await qqBot.start();
  } catch (err) {
    log.error({ err }, 'Failed to start QQ Bot — continuing without bot');
  }

  // ── Step 8: Register graceful shutdown ──
  let shuttingDown = false;

  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, 'Graceful shutdown initiated');

    // Set an overall shutdown timeout — force exit if cleanup hangs
    const forceExitTimer = setTimeout(() => {
      log.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 15000);
    forceExitTimer.unref(); // Don't let this timer keep the event loop alive

    // Broadcast offline notification before stopping services
    try {
      if (qqBot.isConnected()) {
        const msg =
          `🔴 FireFrp 节点下线 (${getDisplayVersion()})\n` +
          `节点: ${config.server.name} (${config.server.id})`;
        await qqBot.broadcastGroupMessage(msg);
        log.info('Offline broadcast sent');
      }
    } catch (err) {
      log.error({ err }, 'Failed to send offline broadcast');
    }

    // Stop QQ Bot
    try {
      await qqBot.stop();
    } catch (err) {
      log.error({ err }, 'Error stopping QQ Bot');
    }

    // Stop accepting new HTTP connections and close idle ones
    try {
      await new Promise<void>((resolve) => {
        httpServer.close((err) => {
          if (err) {
            log.error({ err }, 'Error closing HTTP server');
          } else {
            log.info('HTTP server closed');
          }
          resolve();
        });
      });
    } catch (err) {
      log.error({ err }, 'Error closing HTTP server');
    }

    // Stop rate limit cleanup timer
    stopRateLimitCleanup();

    // Stop expiry service
    expiryService.stop();

    // Cancel all pending MOTD checks
    cancelAllMotdChecks();

    // Stop frps
    try {
      await frpManager.stop();
    } catch (err) {
      log.error({ err }, 'Error stopping frps');
    }

    log.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { gracefulShutdown('SIGINT').catch(() => process.exit(1)); });
  process.on('SIGHUP', () => { gracefulShutdown('SIGHUP').catch(() => process.exit(1)); });

  // Catch unhandled rejections
  process.on('unhandledRejection', (reason, promise) => {
    log.error({ reason, promise: String(promise) }, 'Unhandled Promise rejection');
  });

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception — shutting down');
    gracefulShutdown('uncaughtException').catch(() => process.exit(1));
  });

  log.info('FireFrp Server is fully operational');

  // ── Step 9: Broadcast online notification ──
  try {
    // Give the bot a moment to establish the WebSocket connection
    await new Promise((r) => setTimeout(r, 2000));
    if (qqBot.isConnected()) {
      const msg =
        `🟢 FireFrp 节点上线 (${getDisplayVersion()})\n` +
        `节点: ${config.server.name} (${config.server.id})\n` +
        `地址: ${config.server.publicAddr}\n` +
        `配置: ${config.server.description}`;
      await qqBot.broadcastGroupMessage(msg);
      log.info('Online broadcast sent');
    }
  } catch (err) {
    log.error({ err }, 'Failed to send online broadcast');
  }

  // ── Step 10: Post-update broadcast (download link) ──
  const updateMarkerPath = path.join(config.paths.data, '.just_updated');
  if (fs.existsSync(updateMarkerPath)) {
    try {
      const markerVersion = fs.readFileSync(updateMarkerPath, 'utf-8').trim();

      if (markerVersion !== getVersion()) {
        // Stale marker from a previous failed update cycle, clean up
        fs.unlinkSync(updateMarkerPath);
        log.warn({ markerVersion, currentVersion: getVersion() }, 'Removed stale update marker');
      } else if (qqBot.isConnected()) {
        const ver = getDisplayVersion();
        const downloadUrl = `https://dl.repo.chycloud.top/lieyanc/FireFrp/${ver}`;
        const updateMsg =
          `🔄 FireFrp 已更新至 ${ver}\n` +
          `客户端下载: ${downloadUrl}`;
        await qqBot.broadcastGroupMessage(updateMsg, config.bot.allowedGroups);
        log.info({ version: ver, downloadUrl }, 'Update download broadcast sent');
        // Only delete marker after successful broadcast
        fs.unlinkSync(updateMarkerPath);
      } else {
        log.warn('Bot not connected, deferring update broadcast to next restart');
      }
    } catch (err) {
      log.error({ err }, 'Failed to send update broadcast');
    }
  }
}
