export interface PostgresQueryResult<T = any> {
    rows: T[];
    rowCount: number | null;
}

export interface PostgresClientInterface {
    query<T = any>(queryText: string, values?: any[]): Promise<PostgresQueryResult<T>>;
}

export interface PostgresStorageAdapterOptions {
    client: PostgresClientInterface;
    checkpointsTable?: string;
    eventsTable?: string;
    recordContextChanges?: boolean;
}

export interface PostgresIdempotencyOptions {
    client: PostgresClientInterface;
    tableName?: string;
    defaultTtlMs?: number;
}
