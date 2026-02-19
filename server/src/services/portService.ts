import { config } from '../config';
import { accessKeyStore } from '../db/models/accessKey';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'portService' });

/**
 * Port pool manager.
 * Derives allocated ports from access keys with status pending or active.
 */

/**
 * Get the set of all currently allocated ports.
 */
function getAllocatedPorts(): Set<number> {
  const keys = accessKeyStore.filter(
    (k) => k.status === 'pending' || k.status === 'active',
  );
  return new Set(keys.map((k) => k.remotePort));
}

/**
 * Allocate a random available port from the configured range.
 * Returns the allocated port number, or throws if no ports are available.
 */
export function allocate(): number {
  const allocated = getAllocatedPorts();
  const rangeSize = config.portRangeEnd - config.portRangeStart + 1;

  if (allocated.size >= rangeSize) {
    throw new Error('No available ports in the configured range');
  }

  // Try random selection with a maximum number of attempts
  const maxAttempts = Math.min(rangeSize, 1000);
  for (let i = 0; i < maxAttempts; i++) {
    const port = config.portRangeStart + Math.floor(Math.random() * rangeSize);
    if (!allocated.has(port)) {
      log.info({ port }, 'Port allocated');
      return port;
    }
  }

  // Fallback: sequential scan for a free port
  for (let port = config.portRangeStart; port <= config.portRangeEnd; port++) {
    if (!allocated.has(port)) {
      log.info({ port }, 'Port allocated (sequential fallback)');
      return port;
    }
  }

  throw new Error('No available ports in the configured range');
}

/**
 * Release a port. Since ports are derived from access key status,
 * this is a no-op — port is freed when the key status changes.
 * Provided for interface consistency.
 */
export function release(port: number): void {
  log.info({ port }, 'Port released (status-derived, no-op)');
}

/**
 * Check whether a port is currently allocated.
 */
export function isAllocated(port: number): boolean {
  return getAllocatedPorts().has(port);
}
