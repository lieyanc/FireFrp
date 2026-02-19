import * as path from 'path';
import { JsonStore } from '../store';
import { config } from '../../config';

export interface AuditLog {
  id: number;
  eventType: string;
  keyId?: number;
  details: string;
  createdAt: string;
}

export const auditLogStore = new JsonStore<AuditLog>({
  filePath: path.join(config.paths.data, 'audit_log.json'),
});

/**
 * Convenience function to append an audit log entry.
 */
export function logAuditEvent(eventType: string, keyId: number | undefined, details: string): AuditLog {
  return auditLogStore.insert({
    eventType,
    keyId,
    details,
    createdAt: new Date().toISOString(),
  });
}
