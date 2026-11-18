import { decodeCursor, sortOrder } from '@siglo/query/cursor';
import type { QueryableStorageAdapter, QueryCheckpoint } from '@siglo/query';
import type { PostgresClientInterface } from './types';

type ListWorkflows = NonNullable<QueryableStorageAdapter['queryWorkflows']>;
export type ListingOptions = Parameters<ListWorkflows>[0];

// UTC and millisecond precision keep the index expression immutable and cursor values lossless.
export const creationTime = "date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')";
export const workflowStatus = "COALESCE(state->>'status', 'running')";
const stackId = 'stack_id COLLATE "C"';

export async function listWorkflows(
    client: PostgresClientInterface,
    table: string,
    options: ListingOptions,
): ReturnType<ListWorkflows> {
    const { filter, pagination, includeContext } = options;
    if (!filter?.namespace?.trim()) throw new Error('A workflow namespace is required');
    const limit = pagination?.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid workflow page limit');
    const order = sortOrder(options.sort);
    const sortColumn = {
        createdAt: creationTime,
        updatedAt: "(state->>'timestamp')::bigint",
        revision: 'version',
        status: workflowStatus,
    }[order.field];
    const args: unknown[] = [];
    function bind(value: unknown) {
        args.push(value);
        return '$' + args.length;
    }
    function dateParam(date: Date) {
        return '(' + bind(date.toISOString()) + "::timestamptz AT TIME ZONE 'UTC')";
    }
    const conditions = ['namespace = ' + bind(filter.namespace)];
    if (filter.workflowId !== undefined) conditions.push("state->>'workflowId' = " + bind(filter.workflowId));
    if (filter.status !== undefined) conditions.push(workflowStatus + ' = ' + bind(filter.status));
    if (filter.createdAfter) conditions.push(creationTime + ' > ' + dateParam(filter.createdAfter));
    if (filter.createdBefore) conditions.push(creationTime + ' < ' + dateParam(filter.createdBefore));
    if (filter.correlationKey !== undefined) {
        const wait = "(state->'metadata'->'waitRecord')";
        conditions.push(
            `${wait}->>'correlationKey' = ${bind(filter.correlationKey)}`,
            `${wait}->>'stackId' = stack_id`,
            `(NOT (${wait} ? 'namespace') OR ${wait}->>'namespace' = namespace)`,
        );
    }
    const metadata = Object.entries(filter.metadata ?? {});
    if (metadata.length) {
        conditions.push("(state->'metadata') @> " + bind(JSON.stringify(filter.metadata)) + '::jsonb');
        for (const [key, value] of metadata) {
            conditions.push(`state->'metadata'->${bind(key)}::text = ${bind(JSON.stringify(value))}::jsonb`);
        }
    }
    const where = conditions.join(' AND ');
    const direction = order.direction === 'asc' ? 'ASC' : 'DESC';
    let after = '';
    if (pagination?.cursor !== undefined) {
        const cursor = decodeCursor(pagination.cursor, order);
        const value = order.field === 'createdAt' ? dateParam(new Date(cursor.value)) : bind(cursor.value);
        const op = direction === 'ASC' ? '>' : '<';
        after = `AND (${sortColumn} ${op} ${value} OR (${sortColumn} = ${value} AND ${stackId} > ${bind(cursor.stackId)}))`;
    }
    const size = bind(limit);
    const result = await client.query(
        `
        WITH candidates AS (
            SELECT stack_id, ${sortColumn} AS sort_value FROM ${table}
            WHERE ${where} ${after}
            ORDER BY sort_value ${direction}, ${stackId} LIMIT (${size}::bigint + 1)
        ), page AS (
            SELECT * FROM candidates ORDER BY sort_value ${direction}, ${stackId} LIMIT ${size}
        )
        SELECT totals.*, p.stack_id, extract(epoch FROM ${creationTime}) * 1000 AS created_ms,
               c.namespace, c.version AS revision, state->'version' AS version, state->>'type' AS type,
               state->>'schemaVersion' AS schema_version, state->>'workflowId' AS workflow_id,
               ${workflowStatus} AS status, state->'timestamp' AS timestamp, state->'chains' AS chains,
               state->'expiresAt' AS expires_at, state->'metadata' AS metadata
               ${includeContext ? ", state->'contexts' AS contexts" : ''}
        FROM (SELECT (SELECT count(*) FROM ${table} WHERE ${where}) AS total,
                     EXISTS (SELECT FROM candidates OFFSET ${size}) AS more) totals
        LEFT JOIN page p ON true LEFT JOIN ${table} c ON c.stack_id = p.stack_id
        ORDER BY p.sort_value ${direction}, p.stack_id COLLATE "C"`,
        args,
    );
    const checkpoints: QueryCheckpoint[] = result.rows
        .filter(row => row.stack_id != null)
        .map(row => ({
            stackId: row.stack_id,
            type: row.type,
            version: row.version,
            schemaVersion: row.schema_version ?? undefined,
            revision: Number(row.revision),
            createdAt: Number(row.created_ms),
            namespace: row.namespace,
            workflowId: row.workflow_id ?? undefined,
            status: row.status,
            chains: row.chains,
            timestamp: row.timestamp,
            expiresAt: row.expires_at ?? undefined,
            metadata: row.metadata ?? undefined,
            ...(includeContext && { contexts: row.contexts }),
        }));
    return { checkpoints, totalCount: Number(result.rows[0].total), hasNextPage: result.rows[0].more };
}
