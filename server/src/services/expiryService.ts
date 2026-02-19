import { accessKeyStore } from '../db/models/accessKey';
import { logAuditEvent } from '../db/models/auditLog';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'expiryService' });

/**
 * In-memory reject set: access keys that have expired and should be rejected
 * on frps Ping callbacks immediately (without a DB lookup).
 */
const rejectSet = new Set<string>();

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Check if an access key string is in the reject set.
 */
export function isRejected(key: string): boolean {
  return rejectSet.has(key);
}

/**
 * Add an access key to the reject set.
 */
export function addToRejectSet(key: string): void {
  rejectSet.add(key);
}

/**
 * Scan for expired keys and update their status.
 * - Keys with status "pending" or "active" whose expiresAt has passed are marked "expired".
 * - Their key strings are added to the reject set for fast Ping rejection.
 */
function scanExpiredKeys(): void {
  const now = new Date();
  const candidates = accessKeyStore.filter(
    (k) => (k.status === 'pending' || k.status === 'active') && new Date(k.expiresAt) <= now,
  );

  if (candidates.length === 0) return;

  log.info({ count: candidates.length }, 'Found expired keys');

  for (const key of candidates) {
    accessKeyStore.update(key.id, {
      status: 'expired',
      updatedAt: now.toISOString(),
    });

    rejectSet.add(key.key);

    logAuditEvent('key_expired', key.id, `auto_expire, previous_status=${key.status}`);
    log.info({ keyId: key.id, proxyName: key.proxyName }, 'Key expired');
  }
}

/**
 * Start the expiry service. Scans every 30 seconds.
 */
export function start(): void {
  if (intervalHandle) {
    log.warn('Expiry service already running');
    return;
  }

  // Run an initial scan immediately
  scanExpiredKeys();

  // Then scan every 30 seconds
  intervalHandle = setInterval(() => {
    try {
      scanExpiredKeys();
    } catch (err) {
      log.error({ err }, 'Error during expiry scan');
    }
  }, 30_000);

  log.info('Expiry service started (interval: 30s)');
}

/**
 * Stop the expiry service.
 */
export function stop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('Expiry service stopped');
  }
}
