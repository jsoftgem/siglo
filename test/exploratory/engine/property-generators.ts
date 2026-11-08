/**
 * Seedable Pseudo-Random Number Generator and Property-Based Arbitrary Value Generator.
 * Built with zero external dependencies to ensure fast, deterministic, reproducible exploratory testing.
 */

export class RandomSource {
    private state: number;

    constructor(seed: number = 1337) {
        this.state = seed >>> 0;
    }

    /**
     * Mulberry32 32-bit PRNG
     */
    nextFloat(): number {
        let t = (this.state += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    nextInt(min: number, max: number): number {
        return Math.floor(this.nextFloat() * (max - min + 1)) + min;
    }

    nextBoolean(probability: number = 0.5): boolean {
        return this.nextFloat() < probability;
    }

    pick<T>(items: readonly T[]): T {
        if (items.length === 0) {
            throw new Error('Cannot pick from empty array');
        }
        return items[this.nextInt(0, items.length - 1)];
    }

    sample<T>(items: readonly T[], count: number): T[] {
        const copy = [...items];
        this.shuffle(copy);
        return copy.slice(0, count);
    }

    shuffle<T>(array: T[]): T[] {
        for (let i = array.length - 1; i > 0; i--) {
            const j = this.nextInt(0, i);
            const temp = array[i];
            array[i] = array[j];
            array[j] = temp;
        }
        return array;
    }

    string(length: number = 8): string {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-$';
        let res = '';
        for (let i = 0; i < length; i++) {
            res += chars[this.nextInt(0, chars.length - 1)];
        }
        return res;
    }

    /**
     * Edge case values to stress-test serialization, immutability, and typing.
     */
    edgeCaseScalar(): any {
        const edgeCases = [
            null,
            undefined,
            '',
            ' ',
            '0',
            0,
            -0,
            1,
            -1,
            Number.MAX_SAFE_INTEGER,
            Number.MIN_SAFE_INTEGER,
            true,
            false,
            '__proto__',
            'constructor',
            'prototype',
            'hasOwnProperty',
            'toString',
            '🚀🌟🔥',
            '{"json":"nested"}',
            '<script>alert(1)</script>',
            'a'.repeat(256),
        ];
        return this.pick(edgeCases);
    }

    /**
     * Generates a randomized JSON-compatible payload of variable depth
     */
    jsonPayload(depth: number = 2): any {
        if (depth <= 0) {
            return this.edgeCaseScalar();
        }
        const kind = this.pick(['object', 'array', 'scalar']);
        if (kind === 'scalar') {
            return this.edgeCaseScalar();
        }
        if (kind === 'array') {
            const len = this.nextInt(0, 4);
            const arr: any[] = [];
            for (let i = 0; i < len; i++) {
                arr.push(this.jsonPayload(depth - 1));
            }
            return arr;
        }
        const keysCount = this.nextInt(1, 4);
        const obj: Record<string, any> = {};
        for (let i = 0; i < keysCount; i++) {
            const key = this.pick(['id', 'userId', 'amount', 'status', 'metadata', 'items', 'tag']);
            obj[key + '_' + this.string(3)] = this.jsonPayload(depth - 1);
        }
        return obj;
    }

    /**
     * Generates an object attempting prototype pollution
     */
    prototypePollutionPayload(): Record<string, any> {
        return {
            __proto__: { canary: 'polluted_' + this.string(4) },
            constructor: { prototype: { canary: 'polluted_ctor' } },
            validKey: 'safeValue_' + this.string(4),
        };
    }
}
