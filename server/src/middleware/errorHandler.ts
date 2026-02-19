import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'errorHandler' });

/**
 * Global error handling middleware for Express.
 * Must be registered last (after all routes).
 *
 * Security:
 * - Never leaks internal error details (stack traces, file paths, etc.) in any environment.
 * - Logs the error server-side for debugging but sanitizes sensitive data (request body).
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  log.error(
    {
      err: {
        message: err.message,
        name: err.name,
        // Only include stack trace in non-production logs
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
      },
      method: req.method,
      url: req.originalUrl,
      // Do NOT log req.body — it may contain access keys or other secrets
    },
    'Unhandled error in request',
  );

  // Never leak internal error details to the client, regardless of environment.
  // This prevents information disclosure attacks.
  res.status(500).json({
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
}
