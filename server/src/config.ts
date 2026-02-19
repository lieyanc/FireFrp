import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env file from server root
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const config = {
  /** Express server port */
  serverPort: envInt('SERVER_PORT', 9000),

  /** frp binary version to manage */
  frpVersion: env('FRP_VERSION', '0.67.0'),

  /** frps bind settings */
  frps: {
    bindAddr: env('FRPS_BIND_ADDR', '0.0.0.0'),
    bindPort: envInt('FRPS_BIND_PORT', 7000),
    authToken: env('FRPS_AUTH_TOKEN', 'change_me_to_a_random_string'),
    adminAddr: env('FRPS_ADMIN_ADDR', '127.0.0.1'),
    adminPort: envInt('FRPS_ADMIN_PORT', 7500),
    adminUser: env('FRPS_ADMIN_USER', 'admin'),
    adminPassword: env('FRPS_ADMIN_PASSWORD', 'change_me_admin_password'),
  },

  /** Port allocation range */
  portRangeStart: envInt('PORT_RANGE_START', 10000),
  portRangeEnd: envInt('PORT_RANGE_END', 60000),

  /** Access key settings */
  keyTtlMinutes: envInt('KEY_TTL_MINUTES', 60),
  keyPrefix: env('KEY_PREFIX', 'ff-'),

  /** QQ Bot settings */
  bot: {
    appId: env('BOT_APP_ID', ''),
    token: env('BOT_TOKEN', ''),
    sandbox: envBool('BOT_SANDBOX', true),
  },

  /** Derived paths */
  paths: {
    root: path.resolve(__dirname, '..'),
    data: path.resolve(__dirname, '..', 'data'),
    bin: path.resolve(__dirname, '..', 'bin'),
  },
} as const;

// ─── Security warnings for default/insecure configuration ────────────────
const INSECURE_DEFAULTS = [
  { value: config.frps.authToken, name: 'FRPS_AUTH_TOKEN', default: 'change_me_to_a_random_string' },
  { value: config.frps.adminPassword, name: 'FRPS_ADMIN_PASSWORD', default: 'change_me_admin_password' },
];

for (const check of INSECURE_DEFAULTS) {
  if (check.value === check.default) {
    console.warn(
      `[SECURITY WARNING] ${check.name} is using the default insecure value. ` +
      `Please set a strong, unique value in your .env file before deploying to production.`
    );
  }
}
