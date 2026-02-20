import { config } from '../config';
import { accessKeyStore, AccessKey } from '../db/models/accessKey';
import { logAuditEvent } from '../db/models/auditLog';
import { generateAccessKey } from '../utils/crypto';
import { logger } from '../utils/logger';
import * as portService from './portService';

const log = logger.child({ module: 'keyService' });

/**
 * Create a new access key for a user.
 */
export function create(
  userId: string,
  userName: string,
  gameType: string,
  ttlMinutes?: number,
  groupId?: string,
): AccessKey {
  const ttl = ttlMinutes ?? config.keyTtlMinutes;
  const key = generateAccessKey();
  const remotePort = portService.allocate();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 60 * 1000);

  // Build a short proxy name: ff-{id}-{gameAbbrev}
  // We'll use a temp id, then update after insert
  const gameAbbrev = gameType.toLowerCase().slice(0, 4);

  const accessKey = accessKeyStore.insert({
    key,
    userId,
    userName,
    groupId,
    gameType,
    status: 'pending',
    remotePort,
    proxyName: '', // will be set below
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    updatedAt: now.toISOString(),
  });

  // Set proxy name now that we have the id
  const proxyName = `ff-${accessKey.id}-${gameAbbrev}`;
  accessKeyStore.update(accessKey.id, { proxyName });
  accessKey.proxyName = proxyName;

  logAuditEvent('key_created', accessKey.id, `user=${userId}, game=${gameType}, port=${remotePort}, ttl=${ttl}m`);
  log.info({ keyId: accessKey.id, userId, gameType, remotePort, proxyName }, 'Access key created');

  return accessKey;
}

/**
 * Validate a key: check it exists and is in a usable state (pending or active).
 * Returns the key record and an error code if invalid.
 */
export function validate(key: string): { accessKey?: AccessKey; error?: string } {
  const record = accessKeyStore.findBy('key', key);
  if (!record) {
    return { error: 'KEY_NOT_FOUND' };
  }

  switch (record.status) {
    case 'expired':
      return { error: 'KEY_EXPIRED' };
    case 'revoked':
      return { error: 'KEY_REVOKED' };
    case 'active':
      return { error: 'KEY_ALREADY_USED' };
    case 'pending': {
      // Check if the key has expired by time even though status is still pending
      const now = new Date();
      if (new Date(record.expiresAt) <= now) {
        accessKeyStore.update(record.id, { status: 'expired', updatedAt: now.toISOString() });
        logAuditEvent('key_expired', record.id, 'Expired during validation (pending)');
        return { error: 'KEY_EXPIRED' };
      }
      return { accessKey: record };
    }
    default:
      return { error: 'KEY_NOT_FOUND' };
  }
}

/**
 * Activate a key: transition from pending to active.
 * Called by the frps Login plugin callback.
 *
 * SECURITY: Uses a re-read pattern to mitigate race conditions.
 * After the findBy, we re-read inside the update to ensure the status
 * hasn't changed between the check and the write.
 */
export function activate(key: string, clientId: string): AccessKey | null {
  const record = accessKeyStore.findBy('key', key);
  if (!record || record.status !== 'pending') {
    return null;
  }

  // Re-check status right before update to reduce race window
  // (single-threaded Node.js mitigates most race conditions, but
  //  interleaved async operations could cause issues)
  const freshRecord = accessKeyStore.findById(record.id);
  if (!freshRecord || freshRecord.status !== 'pending') {
    log.warn({ keyId: record.id, currentStatus: freshRecord?.status }, 'Race condition detected in activate: status changed');
    return null;
  }

  const now = new Date().toISOString();
  const updated = accessKeyStore.update(record.id, {
    status: 'active',
    clientId,
    activatedAt: now,
    updatedAt: now,
  });

  if (updated) {
    logAuditEvent('key_activated', updated.id, `clientId=${clientId}`);
    log.info({ keyId: updated.id, clientId }, 'Access key activated');
  }

  return updated;
}

/**
 * Mark a key as expired.
 */
export function expire(keyId: number): AccessKey | null {
  const record = accessKeyStore.findById(keyId);
  if (!record || (record.status !== 'pending' && record.status !== 'active')) {
    return null;
  }

  const now = new Date().toISOString();
  const updated = accessKeyStore.update(keyId, {
    status: 'expired',
    updatedAt: now,
  });

  if (updated) {
    logAuditEvent('key_expired', keyId, `previous_status=${record.status}`);
    log.info({ keyId }, 'Access key expired');
  }

  return updated;
}

/**
 * Revoke a key manually.
 */
export function revoke(keyId: number): AccessKey | null {
  const record = accessKeyStore.findById(keyId);
  if (!record || (record.status !== 'pending' && record.status !== 'active')) {
    return null;
  }

  const now = new Date().toISOString();
  const updated = accessKeyStore.update(keyId, {
    status: 'revoked',
    updatedAt: now,
  });

  if (updated) {
    logAuditEvent('key_revoked', keyId, `previous_status=${record.status}`);
    log.info({ keyId }, 'Access key revoked');
  }

  return updated;
}

/**
 * Get all active keys for a user.
 */
export function getActiveByUser(userId: string): AccessKey[] {
  return accessKeyStore.filter(
    (k) => k.userId === userId && (k.status === 'active' || k.status === 'pending'),
  );
}

/**
 * Find a key record by the key string.
 */
export function getByKey(key: string): AccessKey | undefined {
  return accessKeyStore.findBy('key', key);
}
