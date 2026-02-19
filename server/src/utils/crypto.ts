import * as crypto from 'crypto';
import { config } from '../config';

/**
 * Generate a cryptographically secure access key with the configured prefix.
 * Uses Node.js crypto.randomBytes for true cryptographic randomness.
 *
 * Output: "ff-" + 32 hex characters (128 bits of entropy).
 * Example: "ff-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5"
 *
 * Security notes:
 * - Uses crypto.randomBytes (CSPRNG) instead of nanoid for maximum security.
 * - 32 hex chars = 128 bits of entropy, sufficient for access key use case.
 * - Total key length = prefix (3) + 32 = 35 characters.
 */
export function generateAccessKey(): string {
  const randomPart = crypto.randomBytes(16).toString('hex'); // 32 hex chars, 128 bits
  return `${config.keyPrefix}${randomPart}`;
}

/**
 * Constant-time string comparison to prevent timing attacks during key validation.
 * Both strings must be the same length for a meaningful comparison.
 *
 * @returns true if the strings are equal
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}
