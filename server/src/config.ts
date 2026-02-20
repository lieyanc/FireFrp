import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.resolve(ROOT, 'config.json');
const EXAMPLE_PATH = path.resolve(ROOT, 'config.example.json');

interface MergeResult {
  merged: any;
  deprecated: any;
}

/**
 * Merge user config against example schema:
 *  - Keys in example but missing from user → filled with example defaults
 *  - Keys in both → user value wins
 *  - Keys only in user (removed from example) → collected into deprecated
 * Recurses into plain objects; arrays and primitives are treated as atomic.
 */
function mergeWithSchema(schema: any, user: any): MergeResult {
  const merged: any = {};
  const deprecated: any = {};

  // Schema keys: fill from user or fall back to example default
  for (const key of Object.keys(schema)) {
    const sv = schema[key];
    const uv = user[key];
    if (
      typeof sv === 'object' && sv !== null && !Array.isArray(sv) &&
      typeof uv === 'object' && uv !== null && !Array.isArray(uv)
    ) {
      const sub = mergeWithSchema(sv, uv);
      merged[key] = sub.merged;
      if (Object.keys(sub.deprecated).length > 0) {
        deprecated[key] = sub.deprecated;
      }
    } else if (key in user) {
      merged[key] = uv;
    } else {
      merged[key] = sv;
    }
  }

  // User-only keys (not in schema, not 'deprecated') → collect as deprecated
  for (const key of Object.keys(user)) {
    if (!(key in schema) && key !== 'deprecated') {
      deprecated[key] = user[key];
    }
  }

  return { merged, deprecated };
}

/** Simple deep merge: override values win, recurses into plain objects. */
function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key]) &&
      typeof override[key] === 'object' && override[key] !== null && !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

// If config.json does not exist, copy from config.example.json
if (!fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  console.warn(
    '[CONFIG] config.json not found — created from config.example.json.\n' +
    '         Please edit server/config.json before deploying to production.'
  );
}

const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf-8'));
const userCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const { merged, deprecated } = mergeWithSchema(example, userCfg);
const raw = merged;

// Combine newly deprecated keys with any previously saved deprecated keys
const allDeprecated = deepMerge(userCfg.deprecated || {}, deprecated);
const toWrite: any = { ...raw };
if (Object.keys(allDeprecated).length > 0) {
  toWrite.deprecated = allDeprecated;
}

// Write merged config back so the user can see changes
if (JSON.stringify(toWrite) !== JSON.stringify(userCfg)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2) + '\n');
  if (Object.keys(deprecated).length > 0) {
    console.warn('[CONFIG] config.json updated — deprecated keys moved to "deprecated" object.');
  } else {
    console.warn('[CONFIG] config.json updated — new keys added from config.example.json.');
  }
}

export const config = {
  serverPort: raw.serverPort as number,
  frpVersion: raw.frpVersion as string,

  server: {
    id: raw.server.id as string,
    name: raw.server.name as string,
    publicAddr: raw.server.publicAddr as string,
    description: raw.server.description as string,
  },

  frps: {
    bindAddr: raw.frps.bindAddr as string,
    bindPort: raw.frps.bindPort as number,
    authToken: raw.frps.authToken as string,
    adminAddr: raw.frps.adminAddr as string,
    adminPort: raw.frps.adminPort as number,
    adminUser: raw.frps.adminUser as string,
    adminPassword: raw.frps.adminPassword as string,
  },

  portRangeStart: raw.portRangeStart as number,
  portRangeEnd: raw.portRangeEnd as number,

  keyTtlMinutes: raw.keyTtlMinutes as number,
  keyPrefix: raw.keyPrefix as string,

  bot: {
    wsUrl: raw.bot?.wsUrl as string ?? '',
    token: raw.bot?.token as string ?? '',
    selfId: raw.bot?.selfId as number ?? 0,
    broadcastGroups: (raw.bot?.broadcastGroups ?? []) as number[],
    adminUsers: (raw.bot?.adminUsers ?? []) as number[],
    allowedGroups: (raw.bot?.allowedGroups ?? []) as number[],
  },

  /** Derived paths */
  paths: {
    root: ROOT,
    data: path.resolve(ROOT, 'data'),
    bin: path.resolve(ROOT, 'bin'),
  },
};

/**
 * Save the current config back to config.json.
 * Used for persisting runtime changes (e.g. allowedGroups modifications).
 */
export function saveConfig(): void {
  const toSave: any = {
    serverPort: config.serverPort,
    frpVersion: config.frpVersion,
    server: { ...config.server },
    frps: { ...config.frps },
    portRangeStart: config.portRangeStart,
    portRangeEnd: config.portRangeEnd,
    keyTtlMinutes: config.keyTtlMinutes,
    keyPrefix: config.keyPrefix,
    bot: {
      wsUrl: config.bot.wsUrl,
      token: config.bot.token,
      selfId: config.bot.selfId,
      broadcastGroups: config.bot.broadcastGroups,
      adminUsers: config.bot.adminUsers,
      allowedGroups: config.bot.allowedGroups,
    },
  };

  // Preserve deprecated keys if they exist in current file
  try {
    const current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (current.deprecated) {
      toSave.deprecated = current.deprecated;
    }
  } catch { /* ignore */ }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2) + '\n');
}

// ─── Security warnings for default/insecure configuration ────────────────
const INSECURE_DEFAULTS = [
  { value: config.frps.authToken, name: 'frps.authToken', default: 'change_me_to_a_random_string' },
  { value: config.frps.adminPassword, name: 'frps.adminPassword', default: 'change_me_admin_password' },
];

for (const check of INSECURE_DEFAULTS) {
  if (check.value === check.default) {
    console.warn(
      `[SECURITY WARNING] ${check.name} is using the default insecure value. ` +
      `Please set a strong, unique value in config.json before deploying to production.`
    );
  }
}
