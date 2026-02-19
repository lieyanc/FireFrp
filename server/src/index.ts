import express from 'express';
import { config } from './config';
import { logger } from './utils/logger';
import { accessKeyStore } from './db/models/accessKey';
import { auditLogStore } from './db/models/auditLog';
import { apiRouter } from './api/router';
import { errorHandler } from './middleware/errorHandler';
import { frpManager } from './services/frpManager';
import * as expiryService from './services/expiryService';
import { qqBot } from './bot/qqBot';
import * as fs from 'fs';

const log = logger.child({ module: 'main' });

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

  await new Promise<void>((resolve) => {
    app.listen(config.serverPort, () => {
      log.info({ port: config.serverPort }, 'Express API server started');
      resolve();
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

    // Stop QQ Bot
    try {
      await qqBot.stop();
    } catch (err) {
      log.error({ err }, 'Error stopping QQ Bot');
    }

    // Stop expiry service
    expiryService.stop();

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

  // Catch unhandled rejections
  process.on('unhandledRejection', (reason, promise) => {
    log.error({ reason, promise: String(promise) }, 'Unhandled Promise rejection');
  });

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception — shutting down');
    gracefulShutdown('uncaughtException').catch(() => process.exit(1));
  });

  log.info('FireFrp Server is fully operational');
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
