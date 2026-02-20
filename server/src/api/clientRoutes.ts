import { Router, Request, Response } from 'express';
import { config } from '../config';
import * as keyService from '../services/keyService';
import { getVersion } from '../version';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'clientRoutes' });
const router = Router();

// ─── Rate limiter for /api/v1/validate ───────────────────────────────────
// Per-IP rate limiting: max 20 requests per minute, 100 per hour.
// Prevents brute-force key guessing.

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateLimitMinute = new Map<string, RateBucket>();
const rateLimitHour = new Map<string, RateBucket>();

const RATE_LIMIT_PER_MINUTE = 20;
const RATE_LIMIT_PER_HOUR = 100;

/**
 * Get the client IP from the request, accounting for proxies.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Check rate limit for a given IP. Returns the limit name if exceeded, or null if OK.
 */
function checkRateLimit(ip: string): string | null {
  const now = Date.now();

  // Per-minute check
  let minute = rateLimitMinute.get(ip);
  if (!minute || now >= minute.resetAt) {
    minute = { count: 0, resetAt: now + 60_000 };
    rateLimitMinute.set(ip, minute);
  }
  if (minute.count >= RATE_LIMIT_PER_MINUTE) {
    return 'minute';
  }
  minute.count++;

  // Per-hour check
  let hour = rateLimitHour.get(ip);
  if (!hour || now >= hour.resetAt) {
    hour = { count: 0, resetAt: now + 3600_000 };
    rateLimitHour.set(ip, hour);
  }
  if (hour.count >= RATE_LIMIT_PER_HOUR) {
    return 'hour';
  }
  hour.count++;

  return null;
}

// Periodically clean up stale rate limit entries (every 5 minutes)
let rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitMinute) {
    if (now >= bucket.resetAt) rateLimitMinute.delete(ip);
  }
  for (const [ip, bucket] of rateLimitHour) {
    if (now >= bucket.resetAt) rateLimitHour.delete(ip);
  }
}, 300_000);

/**
 * Stop the rate limit cleanup timer. Called during graceful shutdown.
 */
export function stopRateLimitCleanup(): void {
  if (rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer);
    rateLimitCleanupTimer = null;
  }
}

// ─── Input validation helpers ────────────────────────────────────────────

const KEY_MAX_LENGTH = 128;
const KEY_PATTERN = /^[a-zA-Z0-9\-_]+$/;

/**
 * POST /api/v1/validate
 * Validate an access key and return frps connection parameters.
 *
 * Request body: { "key": "ff-xxxx..." }
 * Success response: { "ok": true, "data": { frps_addr, frps_port, remote_port, token, proxy_name, expires_at } }
 * Error response: { "ok": false, "error": { "code": "KEY_NOT_FOUND", "message": "..." } }
 */
router.post('/api/v1/validate', (req: Request, res: Response) => {
  try {
    // ── Rate limiting ──
    const clientIp = getClientIp(req);
    const rateLimited = checkRateLimit(clientIp);
    if (rateLimited) {
      log.warn({ ip: clientIp, window: rateLimited }, 'Rate limit exceeded on /api/v1/validate');
      res.status(429).json({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
      });
      return;
    }

    // ── Input validation ──
    const { key } = req.body as { key?: string };

    if (!key || typeof key !== 'string') {
      res.status(400).json({
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'Missing or invalid "key" field' },
      });
      return;
    }

    // Reject keys that are too long or contain invalid characters
    if (key.length > KEY_MAX_LENGTH || !KEY_PATTERN.test(key)) {
      res.status(400).json({
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid key format' },
      });
      return;
    }

    const result = keyService.validate(key);

    if (result.error) {
      const statusMap: Record<string, number> = {
        KEY_NOT_FOUND: 404,
        KEY_EXPIRED: 410,
        KEY_ALREADY_USED: 409,
        KEY_REVOKED: 403,
        KEY_DISCONNECTED: 410,
      };

      const messageMap: Record<string, string> = {
        KEY_NOT_FOUND: 'Access key not found',
        KEY_EXPIRED: 'Access key has expired',
        KEY_ALREADY_USED: 'Access key is already in use',
        KEY_REVOKED: 'Access key has been revoked',
        KEY_DISCONNECTED: 'Access key tunnel has been disconnected',
      };

      const httpStatus = statusMap[result.error] ?? 400;
      const message = messageMap[result.error] ?? 'Unknown error';

      log.warn({ key: key.slice(0, 10) + '...', errorCode: result.error }, 'Key validation failed');

      res.status(httpStatus).json({
        ok: false,
        error: { code: result.error, message },
      });
      return;
    }

    const ak = result.accessKey!;

    log.info({ keyId: ak.id, proxyName: ak.proxyName }, 'Key validated successfully');

    res.json({
      ok: true,
      data: {
        frps_addr: config.frps.bindAddr === '0.0.0.0'
          ? req.hostname  // Use the request hostname if frps binds to all interfaces
          : config.frps.bindAddr,
        frps_port: config.frps.bindPort,
        remote_port: ak.remotePort,
        token: config.frps.authToken,
        proxy_name: ak.proxyName,
        expires_at: ak.expiresAt,
      },
    });
  } catch (err) {
    log.error({ err }, 'Error in /api/v1/validate');
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * GET /api/v1/server-info
 * Returns this server's self-configuration for client-side server discovery.
 */
router.get('/api/v1/server-info', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    data: {
      id: config.server.id,
      name: config.server.name,
      public_addr: config.server.publicAddr,
      description: config.server.description,
      client_version: getVersion(),
    },
  });
});

export { router as clientRoutes };
