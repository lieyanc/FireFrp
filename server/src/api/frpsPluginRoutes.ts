import { Router, Request, Response } from 'express';
import * as keyService from '../services/keyService';
import { logAuditEvent } from '../db/models/auditLog';
import { isRejected, addToRejectSet } from '../services/expiryService';
import { logger } from '../utils/logger';
import { qqBot } from '../bot/qqBot';
import { config } from '../config';

const log = logger.child({ module: 'frpsPlugin' });
const router = Router();

/**
 * frps Server Plugin protocol (v0.67.0):
 *
 * Request from frps:
 * {
 *   "version": "0.1.0",
 *   "op": "Login" | "NewProxy" | "CloseProxy" | "Ping",
 *   "content": { ... }
 * }
 *
 * Response to frps:
 * {
 *   "reject": false,
 *   "reject_reason": "",
 *   "unchange": true
 * }
 *
 * or for rejection:
 * {
 *   "reject": true,
 *   "reject_reason": "some reason"
 * }
 */

// ─── Allowed source IPs for frps plugin callbacks ────────────────────────
// Only loopback addresses are allowed since frps runs as a local subprocess.
const ALLOWED_PLUGIN_SOURCES = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost',
]);

/**
 * Validate that the request originates from the frps process (loopback only).
 * Returns true if the source is trusted, false otherwise.
 */
function isFromFrps(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  // Normalize IPv6-mapped IPv4
  const normalizedIp = ip.replace(/^::ffff:/, '');
  return ALLOWED_PLUGIN_SOURCES.has(ip) || ALLOWED_PLUGIN_SOURCES.has(normalizedIp);
}

interface PluginRequest {
  version: string;
  op: string;
  content: Record<string, unknown>;
}

function allow(unchange: boolean = true) {
  return {
    reject: false,
    reject_reason: '',
    unchange,
  };
}

function reject(reason: string) {
  return {
    reject: true,
    reject_reason: reason,
  };
}

/**
 * Handle Login operation.
 * Validates the access_key from metas, transitions pending -> active.
 */
function handleLogin(content: Record<string, unknown>): object {
  const metas = content.metas as Record<string, string> | undefined;
  const accessKey = metas?.access_key;

  if (!accessKey) {
    log.warn('Login: no access_key in metas');
    return reject('Missing access_key in metas');
  }

  const record = keyService.getByKey(accessKey);
  if (!record) {
    log.warn({ key: accessKey.slice(0, 10) + '...' }, 'Login: key not found');
    return reject('Invalid access key');
  }

  // Check if expired by time
  if (new Date(record.expiresAt) <= new Date()) {
    log.warn({ keyId: record.id }, 'Login: key expired');
    addToRejectSet(accessKey);
    return reject('Access key has expired');
  }

  switch (record.status) {
    case 'expired':
      return reject('Access key has expired');
    case 'revoked':
      return reject('Access key has been revoked');
    case 'active':
      // Allow reconnection with the same key if it's still active
      log.info({ keyId: record.id }, 'Login: active key reconnecting');
      return allow();
    case 'pending': {
      // Activate the key
      const runId = (content.run_id as string) ?? 'unknown';
      const activated = keyService.activate(accessKey, runId);
      if (!activated) {
        log.error({ keyId: record.id }, 'Login: failed to activate key');
        return reject('Failed to activate access key');
      }
      log.info({ keyId: activated.id, clientId: runId }, 'Login: key activated');

      // Notify the originating group that the tunnel is established
      if (activated.groupId) {
        const addr = `${config.server.publicAddr}:${activated.remotePort}`;
        qqBot.notifyTunnelConnected(
          Number(activated.groupId),
          Number(activated.userId),
          activated.userName,
          activated.gameType,
          addr,
        ).catch((err) => {
          log.error({ err, groupId: activated.groupId }, 'Failed to send tunnel notification');
        });
      }

      return allow();
    }
    default:
      return reject('Invalid key status');
  }
}

/**
 * Handle NewProxy operation.
 * Validates that the proxy_name and remote_port match the key record.
 */
function handleNewProxy(content: Record<string, unknown>): object {
  const proxyName = content.proxy_name as string | undefined;
  const proxyType = content.proxy_type as string | undefined;

  // Extract user info to find the key
  const userInfo = content.user as Record<string, unknown> | undefined;
  const metas = userInfo?.metas as Record<string, string> | undefined;
  const accessKey = metas?.access_key;

  if (!accessKey) {
    log.warn({ proxyName }, 'NewProxy: cannot determine access_key');
    // Reject if we cannot determine the access key — do not allow unidentified proxies
    return reject('Missing access_key in user metas');
  }

  const record = keyService.getByKey(accessKey);
  if (!record) {
    log.warn({ proxyName, key: accessKey.slice(0, 10) + '...' }, 'NewProxy: key not found');
    return reject('Invalid access key');
  }

  // Validate proxy name matches
  if (proxyName && proxyName !== record.proxyName) {
    log.warn({ expected: record.proxyName, actual: proxyName }, 'NewProxy: proxy name mismatch');
    return reject(`Proxy name must be ${record.proxyName}`);
  }

  // Validate remote port if present in the proxy config
  const remotePort = content.remote_port as number | undefined;
  if (remotePort !== undefined && remotePort !== record.remotePort) {
    log.warn({ expected: record.remotePort, actual: remotePort }, 'NewProxy: remote port mismatch');
    return reject(`Remote port must be ${record.remotePort}`);
  }

  // Only allow TCP type
  if (proxyType && proxyType !== 'tcp') {
    log.warn({ proxyType }, 'NewProxy: only tcp proxies are allowed');
    return reject('Only TCP proxies are allowed');
  }

  log.info({ keyId: record.id, proxyName, proxyType }, 'NewProxy: allowed');
  return allow();
}

/**
 * Handle Ping operation.
 * Checks the reject set and data status. If expired, reject to disconnect client.
 */
function handlePing(content: Record<string, unknown>): object {
  const userInfo = content.user as Record<string, unknown> | undefined;
  const metas = userInfo?.metas as Record<string, string> | undefined;
  const accessKey = metas?.access_key;

  if (!accessKey) {
    // Can't determine key, allow the ping
    return allow();
  }

  // Fast path: check in-memory reject set
  if (isRejected(accessKey)) {
    log.info({ key: accessKey.slice(0, 10) + '...' }, 'Ping: rejected (in reject set)');
    return reject('Access key has expired');
  }

  // Slow path: check database record
  const record = keyService.getByKey(accessKey);
  if (!record) {
    return reject('Invalid access key');
  }

  if (record.status === 'expired' || record.status === 'revoked') {
    addToRejectSet(accessKey);
    log.info({ keyId: record.id, status: record.status }, 'Ping: rejected (status check)');
    return reject(`Access key is ${record.status}`);
  }

  // Check time-based expiry
  if (new Date(record.expiresAt) <= new Date()) {
    addToRejectSet(accessKey);
    log.info({ keyId: record.id }, 'Ping: rejected (time expired)');
    return reject('Access key has expired');
  }

  return allow();
}

/**
 * Handle CloseProxy operation.
 * Log the event for auditing.
 */
function handleCloseProxy(content: Record<string, unknown>): object {
  const proxyName = content.proxy_name as string | undefined;
  const userInfo = content.user as Record<string, unknown> | undefined;
  const metas = userInfo?.metas as Record<string, string> | undefined;
  const accessKey = metas?.access_key;

  if (accessKey) {
    const record = keyService.getByKey(accessKey);
    if (record) {
      logAuditEvent('proxy_closed', record.id, `proxy=${proxyName}`);
      log.info({ keyId: record.id, proxyName }, 'CloseProxy: logged');
    }
  } else {
    log.info({ proxyName }, 'CloseProxy: no access_key, audit skipped');
  }

  return allow();
}

/**
 * POST /frps-plugin/handler
 * Main frps plugin callback endpoint.
 * Only accepts requests from loopback addresses (frps subprocess).
 */
router.post('/frps-plugin/handler', (req: Request, res: Response) => {
  try {
    // ── Source validation: only accept from frps (loopback) ──
    if (!isFromFrps(req)) {
      const sourceIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      log.warn({ sourceIp }, 'Plugin callback rejected: untrusted source IP');
      res.status(403).json(reject('Forbidden'));
      return;
    }

    const body = req.body as PluginRequest;
    const { op, content } = body;

    // ── Basic input validation ──
    if (!op || typeof op !== 'string') {
      log.warn({ body }, 'Plugin callback: missing or invalid "op" field');
      res.json(reject('Invalid request: missing op'));
      return;
    }

    if (!content || typeof content !== 'object') {
      log.warn({ op }, 'Plugin callback: missing or invalid "content" field');
      res.json(reject('Invalid request: missing content'));
      return;
    }

    log.debug({ op, version: body.version }, 'Plugin callback received');

    let response: object;

    switch (op) {
      case 'Login':
        response = handleLogin(content);
        break;
      case 'NewProxy':
        response = handleNewProxy(content);
        break;
      case 'Ping':
        response = handlePing(content);
        break;
      case 'CloseProxy':
        response = handleCloseProxy(content);
        break;
      default:
        log.warn({ op }, 'Unknown plugin operation');
        response = allow();
    }

    res.json(response);
  } catch (err) {
    log.error({ err }, 'Error in frps plugin handler');
    // On error, reject to be safe
    res.json(reject('Internal server error'));
  }
});

export { router as frpsPluginRoutes };
