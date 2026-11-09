import crypto from 'node:crypto';
import { EncryptedEnvelope } from '../types';

/**
 * Type guard for EncryptedEnvelope.
 */
export function isEncryptedEnvelope(val: unknown): val is EncryptedEnvelope {
    return (
        typeof val === 'object' &&
        val !== null &&
        (val as any).__sigloCipher === 'aes-256-gcm' &&
        typeof (val as any).iv === 'string' &&
        typeof (val as any).tag === 'string' &&
        typeof (val as any).data === 'string'
    );
}

const PASSPHRASE_KDF_SALT = Buffer.from('siglo.aes-256-gcm.passphrase.v1', 'utf8');

/**
 * Resolves a 256-bit (32-byte) key buffer from a string or Buffer.
 * Supports raw 32-byte Buffers, 64-char hex strings, 32-char UTF-8 strings,
 * or derives a 32-byte key via salted PBKDF2 (HMAC-SHA256, 10,000 rounds) for arbitrary passphrases.
 */
export function resolveKey(key: string | Buffer): Buffer {
    if (Buffer.isBuffer(key)) {
        if (key.length === 32) {
            return key;
        }
        return crypto.pbkdf2Sync(key, PASSPHRASE_KDF_SALT, 10000, 32, 'sha256');
    }

    if (typeof key === 'string') {
        if (key.length === 64 && /^[0-9a-fA-F]{64}$/.test(key)) {
            return Buffer.from(key, 'hex');
        }
        const utf8Buf = Buffer.from(key, 'utf8');
        if (utf8Buf.length === 32) {
            return utf8Buf;
        }
        return crypto.pbkdf2Sync(key, PASSPHRASE_KDF_SALT, 10000, 32, 'sha256');
    }

    throw new TypeError('Secret key must be a string or Buffer');
}

/**
 * Derives a context-bound 256-bit subkey from a master key using RFC 5869 HKDF.
 * Isolates cryptographic keyspaces per tenant, workflow run, or checkpoint.
 */
export function deriveSubkey(masterKey: string | Buffer, contextInfo: string | Buffer, salt?: string | Buffer): Buffer {
    const resolvedMaster = resolveKey(masterKey);
    const resolvedSalt = salt ? (Buffer.isBuffer(salt) ? salt : Buffer.from(salt)) : Buffer.alloc(32, 0);
    const info = Buffer.isBuffer(contextInfo) ? contextInfo : Buffer.from(contextInfo);
    return Buffer.from(crypto.hkdfSync('sha256', resolvedMaster, resolvedSalt, info, 32));
}

/** Key invocation tracking per key hash to warn/guard against NIST SP 800-38D limits */
const keyUsageCounts = new Map<string, number>();

/** NIST SP 800-38D recommended maximum threshold for 96-bit random IVs (2^24) */
export const NIST_RECOMMENDED_INVOCATION_CEILING = 16777216;

export function getKeyInvocationCount(key: string | Buffer): number {
    const hash = crypto.createHash('sha256').update(resolveKey(key)).digest('hex');
    return keyUsageCounts.get(hash) ?? 0;
}

export function resetKeyInvocationCounters(): void {
    keyUsageCounts.clear();
}

function recordKeyUsage(key: Buffer): void {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const current = (keyUsageCounts.get(hash) ?? 0) + 1;
    keyUsageCounts.set(hash, current);
    if (current === NIST_RECOMMENDED_INVOCATION_CEILING) {
        if (typeof process !== 'undefined' && process.emitWarning) {
            process.emitWarning(
                `AES-GCM key usage for key fingerprint '${hash.slice(0, 8)}' reached ${NIST_RECOMMENDED_INVOCATION_CEILING} invocations. Key rotation recommended per NIST SP 800-38D.`,
                'SecurityWarning',
            );
        }
    }
}

export interface EncryptOptions {
    kid?: string;
    aad?: string | Buffer;
    deriveKeyContext?: string | Buffer;
    v?: number;
}

export interface DecryptOptions {
    aad?: string | Buffer;
    deriveKeyContext?: string | Buffer;
}

/**
 * Encrypts arbitrary data using AES-256-GCM envelope encryption.
 * Generates a cryptographically secure 96-bit (12-byte) IV for each invocation.
 * Supports AAD (Additional Authenticated Data) and context-derived subkeys.
 */
export function encryptAESGCM(data: unknown, key: string | Buffer, options?: EncryptOptions): EncryptedEnvelope {
    let resolvedKey = resolveKey(key);
    if (options?.deriveKeyContext) {
        resolvedKey = deriveSubkey(resolvedKey, options.deriveKeyContext);
    }

    recordKeyUsage(resolvedKey);

    const iv = crypto.randomBytes(12);
    const plaintext = JSON.stringify(data);
    const cipher = crypto.createCipheriv('aes-256-gcm', resolvedKey, iv);

    if (options?.aad) {
        const aadBuf = Buffer.isBuffer(options.aad) ? options.aad : Buffer.from(options.aad);
        cipher.setAAD(aadBuf);
    }

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    const tag = cipher.getAuthTag();

    const envelope: EncryptedEnvelope = {
        __sigloCipher: 'aes-256-gcm',
        v: options?.v ?? 1,
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        data: ciphertext.toString('hex'),
    };

    if (options?.kid) {
        envelope.kid = options.kid;
    }

    return envelope;
}

/**
 * Decrypts an AES-256-GCM envelope and verifies authentication tag integrity.
 * Supports AAD verification and context-derived subkey reconstruction.
 * Throws if the auth tag, ciphertext, or AAD was tampered with.
 */
export function decryptAESGCM(envelope: EncryptedEnvelope, key: string | Buffer, options?: DecryptOptions): any {
    if (!isEncryptedEnvelope(envelope)) {
        throw new TypeError('Invalid encrypted envelope structure');
    }

    let resolvedKey = resolveKey(key);
    if (options?.deriveKeyContext) {
        resolvedKey = deriveSubkey(resolvedKey, options.deriveKeyContext);
    }

    const iv = Buffer.from(envelope.iv, 'hex');
    const tag = Buffer.from(envelope.tag, 'hex');
    const ciphertext = Buffer.from(envelope.data, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', resolvedKey, iv);

    if (options?.aad) {
        const aadBuf = Buffer.isBuffer(options.aad) ? options.aad : Buffer.from(options.aad);
        decipher.setAAD(aadBuf);
    }

    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const plaintextStr = decrypted.toString('utf8');
    try {
        return JSON.parse(plaintextStr);
    } catch {
        return plaintextStr;
    }
}
