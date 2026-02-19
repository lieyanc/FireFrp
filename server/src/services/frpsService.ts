import fetch from 'node-fetch';
import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'frpsService' });

/**
 * frps Admin API client.
 * Communicates with the frps web server (admin dashboard API) over HTTP.
 */

function getBaseUrl(): string {
  return `http://${config.frps.adminAddr}:${config.frps.adminPort}`;
}

function getAuthHeader(): string {
  return `Basic ${Buffer.from(`${config.frps.adminUser}:${config.frps.adminPassword}`).toString('base64')}`;
}

async function apiGet<T>(path: string): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: getAuthHeader() },
    timeout: 5000,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`frps API ${path} returned ${resp.status}: ${body}`);
  }

  return resp.json() as Promise<T>;
}

// ─── Types ─────────────────────────────────────────────────────────────

export interface FrpsServerInfo {
  version: string;
  bindPort: number;
  vhostHttpPort: number;
  vhostHttpsPort: number;
  totalTrafficIn: number;
  totalTrafficOut: number;
  curConns: number;
  clientCounts: number;
  proxyTypeCounts: Record<string, number>;
}

export interface FrpsProxy {
  name: string;
  type: string;
  status: string;
  todayTrafficIn: number;
  todayTrafficOut: number;
  curConns: number;
  lastStartTime: string;
  lastCloseTime: string;
  conf?: Record<string, unknown>;
}

export interface FrpsProxyListResponse {
  proxies: FrpsProxy[];
}

export interface FrpsTrafficInfo {
  name: string;
  trafficIn: number[];
  trafficOut: number[];
}

// ─── API methods ───────────────────────────────────────────────────────

/**
 * Get frps server info.
 */
export async function getServerInfo(): Promise<FrpsServerInfo> {
  log.debug('Fetching server info');
  return apiGet<FrpsServerInfo>('/api/serverinfo');
}

/**
 * Get all TCP proxies.
 */
export async function getProxies(): Promise<FrpsProxyListResponse> {
  log.debug('Fetching proxy list');
  return apiGet<FrpsProxyListResponse>('/api/proxy/tcp');
}

/**
 * Get a specific proxy by name.
 */
export async function getProxy(name: string): Promise<FrpsProxy> {
  log.debug({ name }, 'Fetching proxy');
  return apiGet<FrpsProxy>(`/api/proxy/tcp/${encodeURIComponent(name)}`);
}

/**
 * Get traffic statistics for a proxy.
 */
export async function getTraffic(name: string): Promise<FrpsTrafficInfo> {
  log.debug({ name }, 'Fetching traffic');
  return apiGet<FrpsTrafficInfo>(`/api/traffic/${encodeURIComponent(name)}`);
}
