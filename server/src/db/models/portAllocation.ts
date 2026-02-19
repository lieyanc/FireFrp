import { accessKeyStore, AccessKey } from './accessKey';

/**
 * Port allocation is derived from access keys.
 * We do not maintain a separate port allocation store.
 * This module provides helper functions to query allocated ports.
 */

/**
 * Returns a Set of all ports currently allocated (status pending or active).
 */
export function getAllocatedPorts(): Set<number> {
  const keys = accessKeyStore.filter(
    (k: AccessKey) => k.status === 'pending' || k.status === 'active',
  );
  return new Set(keys.map((k) => k.remotePort));
}

/**
 * Check if a specific port is currently allocated.
 */
export function isPortAllocated(port: number): boolean {
  return getAllocatedPorts().has(port);
}
