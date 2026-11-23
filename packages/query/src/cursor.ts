import { isPlainObject } from '@siglo/core';
import type { QueryCheckpoint, WorkflowSortInput } from './types';

export function sortOrder(sort?: WorkflowSortInput) {
    const field = sort?.field ?? 'createdAt';
    const direction = sort?.direction ?? 'desc';
    if (!['createdAt', 'updatedAt', 'status', 'revision'].includes(field) || !['asc', 'desc'].includes(direction))
        throw new Error('Invalid workflow sort');
    return { field, direction };
}

type Order = ReturnType<typeof sortOrder>;
type Position = { value: string | number; stackId: string };

export function position(record: QueryCheckpoint, { field }: Order): Position {
    const values = {
        createdAt: record.createdAt ?? record.timestamp,
        updatedAt: record.timestamp,
        revision: record.revision,
        status: record.status ?? 'running',
    };
    return { value: values[field], stackId: record.stackId };
}

export function compare(a: Position, b: Position, order: Order) {
    const diff = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    if (diff) return order.direction === 'asc' ? diff : -diff;
    return a.stackId < b.stackId ? -1 : Number(a.stackId > b.stackId);
}

export function encodeCursor(record: QueryCheckpoint, order: Order) {
    return Buffer.from(JSON.stringify({ ...order, ...position(record, order) })).toString('base64url');
}

export function decodeCursor(cursor: string, order: Order): Position {
    try {
        const bytes = Buffer.from(cursor, 'base64url');
        const data: unknown = JSON.parse(bytes.toString());
        if (
            isPlainObject(data) &&
            bytes.toString('base64url') === cursor &&
            data.field === order.field &&
            data.direction === order.direction &&
            typeof data.stackId === 'string' &&
            ((order.field === 'status' && typeof data.value === 'string') ||
                (order.field !== 'status' && typeof data.value === 'number' && Number.isFinite(data.value)))
        )
            return { value: data.value, stackId: data.stackId };
    } catch {
        // Treat malformed and incompatible tokens alike.
    }
    throw new Error('Invalid workflow cursor');
}
