import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.resolve(ROOT, 'config.json');
const EXAMPLE_PATH = path.resolve(ROOT, 'config.example.json');

// If config.json does not exist, copy from config.example.json
if (!fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  console.warn(
    '[CONFIG] config.json not found — created from config.example.json.\n' +
    '         Please edit server/config.json before deploying to production.'
  );
}

const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

export const config = {
  serverPort: raw.serverPort as number,
  frpVersion: raw.frpVersion as string,

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
  },

  /** Derived paths */
  paths: {
    root: ROOT,
    data: path.resolve(ROOT, 'data'),
    bin: path.resolve(ROOT, 'bin'),
  },
} as const;

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
