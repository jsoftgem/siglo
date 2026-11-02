import crypto from 'node:crypto';

/**
 * Constant-time equality check to prevent side-channel timing attacks.
 * Uses `crypto.timingSafeEqual` with strict buffer length checks.
 */
export function timingSafeCompare(
  computed: string | Buffer,
  provided: string | Buffer,
  encoding: BufferEncoding = 'hex'
): boolean {
  try {
    const bufA = Buffer.isBuffer(computed) ? computed : Buffer.from(computed, encoding);
    const bufB = Buffer.isBuffer(provided) ? provided : Buffer.from(provided, encoding);

    if (bufA.length === 0 || bufB.length === 0 || bufA.length !== bufB.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
