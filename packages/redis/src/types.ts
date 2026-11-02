export interface RedisClientInterface {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: any[]): Promise<'OK' | string | null>;
    del(key: string | string[]): Promise<number>;
    hset(key: string, field: string | Record<string, string>, value?: string): Promise<number>;
    hgetall?(key: string): Promise<Record<string, string>>;
    expire?(key: string, seconds: number): Promise<number>;
    pexpire?(key: string, milliseconds: number): Promise<number>;
    eval?(script: string, numKeys: number, ...args: (string | number)[]): Promise<any>;
}

export interface RedisStorageAdapterOptions {
    client: RedisClientInterface;
    keyPrefix?: string;
    cacheTtlMs?: number;
    checkpointTtlMs?: number;
    recordContextChanges?: boolean;
}

export interface RedisIdempotencyOptions {
    client: RedisClientInterface;
    keyPrefix?: string;
    defaultTtlMs?: number;
}

export interface RedisNonceStoreOptions {
    client: RedisClientInterface;
    keyPrefix?: string;
}
