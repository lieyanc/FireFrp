import * as path from 'path';
import { JsonStore } from '../store';
import { config } from '../../config';

export interface AccessKey {
  id: number;
  tunnelId: string;
  key: string;
  userId: string;
  userName: string;
  groupId?: string;
  gameType: string;
  status: 'pending' | 'active' | 'expired' | 'revoked' | 'disconnected';
  remotePort: number;
  proxyName: string;
  clientId?: string;
  createdAt: string;
  activatedAt?: string;
  expiresAt: string;
  updatedAt: string;
}

export const accessKeyStore = new JsonStore<AccessKey>({
  filePath: path.join(config.paths.data, 'access_keys.json'),
});
