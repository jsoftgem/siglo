import { KeyRing, KeyRingKey } from '../types';

/**
 * Type guard to check if an object satisfies the KeyRing interface.
 */
export function isKeyRing(val: unknown): val is KeyRing {
    return (
        typeof val === 'object' &&
        val !== null &&
        typeof (val as any).getActiveKey === 'function' &&
        typeof (val as any).getKey === 'function'
    );
}

/**
 * In-memory multi-key provider supporting active key generation and historical key retrieval.
 */
export class StaticKeyRing implements KeyRing {
    private activeKeyId: string;
    private keys: Map<string, string | Buffer> = new Map();

    constructor(activeKeyId: string, keys: Record<string, string | Buffer> | Map<string, string | Buffer>) {
        this.activeKeyId = activeKeyId;
        if (keys instanceof Map) {
            this.keys = new Map(keys);
        } else {
            for (const [kid, key] of Object.entries(keys)) {
                this.keys.set(kid, key);
            }
        }
        if (!this.keys.has(activeKeyId)) {
            throw new Error(`Active key ID '${activeKeyId}' not found in provided keys`);
        }
    }

    getActiveKey(): KeyRingKey {
        const key = this.keys.get(this.activeKeyId);
        if (!key) {
            throw new Error(`Active key '${this.activeKeyId}' not found in KeyRing`);
        }
        return {
            kid: this.activeKeyId,
            key,
        };
    }

    getKey(kid: string): string | Buffer | null {
        return this.keys.get(kid) ?? null;
    }

    /**
     * Adds or rotates a key in the ring.
     */
    addKey(kid: string, key: string | Buffer, makeActive: boolean = false): void {
        this.keys.set(kid, key);
        if (makeActive) {
            this.activeKeyId = kid;
        }
    }

    /**
     * Sets the active key ID for subsequent encryption operations.
     */
    setActiveKey(kid: string): void {
        if (!this.keys.has(kid)) {
            throw new Error(`Cannot set active key to '${kid}': key not found in KeyRing`);
        }
        this.activeKeyId = kid;
    }
}
