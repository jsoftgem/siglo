import type { SerializedExecutionStack } from '@siglo/core';
import { isDeepStrictEqual } from 'node:util';
import { compare, decodeCursor, position, sortOrder } from './cursor';
import type { QueryableStorageAdapter, QueryCheckpoint, WorkflowFilterInput } from './types';

function matches(record: QueryCheckpoint, filter: WorkflowFilterInput) {
    const created = record.createdAt ?? record.timestamp;
    const wait = record.metadata?.waitRecord;
    return (
        record.namespace === filter.namespace &&
        (filter.workflowId === undefined || record.workflowId === filter.workflowId) &&
        (filter.status === undefined || (record.status ?? 'running') === filter.status) &&
        (!filter.createdAfter || created > filter.createdAfter.getTime()) &&
        (!filter.createdBefore || created < filter.createdBefore.getTime()) &&
        (filter.correlationKey === undefined ||
            (wait?.correlationKey === filter.correlationKey &&
                wait.stackId === record.stackId &&
                (wait.namespace === undefined || wait.namespace === filter.namespace))) &&
        Object.entries(filter.metadata ?? {}).every(
            ([key, value]) =>
                record.metadata &&
                Object.hasOwn(record.metadata, key) &&
                isDeepStrictEqual(record.metadata[key], value),
        )
    );
}

export class MemoryStorageAdapter implements QueryableStorageAdapter {
    readonly name = 'memory';
    private readonly records = new Map<
        string,
        {
            summary: Omit<SerializedExecutionStack, 'contexts'> & { createdAt: number };
            contexts: SerializedExecutionStack['contexts'];
        }
    >();

    async saveCheckpoint(checkpoint: SerializedExecutionStack) {
        const existing = this.records.get(checkpoint.stackId);
        if (existing && existing.summary.revision > checkpoint.revision) return;
        // Match persistent adapters when core includes runtime step functions in wait metadata.
        const { contexts, ...summary }: SerializedExecutionStack = JSON.parse(JSON.stringify(checkpoint));
        this.records.set(checkpoint.stackId, {
            summary: { ...summary, createdAt: existing?.summary.createdAt ?? checkpoint.timestamp },
            contexts,
        });
    }

    async getCheckpoint(stackId: string) {
        const record = this.records.get(stackId);
        return record && structuredClone({ ...record.summary, contexts: record.contexts });
    }

    async cancelWorkflow(stackId: string): Promise<void> {
        const record = this.records.get(stackId);
        if (record) {
            record.summary.status = 'cancelled';
            record.summary.revision += 1;
            record.summary.timestamp = Date.now();
            if (record.summary.metadata?.waitRecord) {
                (record.summary.metadata.waitRecord as any).status = 'CANCELLED';
            }
        }
    }

    async getWaitRecord(correlationKeyOrStackId: string): Promise<any | undefined> {
        for (const record of this.records.values()) {
            const wait = record.summary.metadata?.waitRecord as any;
            if (
                wait?.correlationKey === correlationKeyOrStackId ||
                record.summary.stackId === correlationKeyOrStackId
            ) {
                return structuredClone(wait);
            }
        }
        return undefined;
    }

    async queryWorkflows({
        filter,
        sort,
        pagination,
        includeContext,
    }: Parameters<NonNullable<QueryableStorageAdapter['queryWorkflows']>>[0]) {
        const order = sortOrder(sort);
        const cursor = pagination?.cursor === undefined ? undefined : decodeCursor(pagination.cursor, order);
        const matchesFilter = Array.from(this.records.values(), record => record.summary).filter(record =>
            matches(record, filter),
        );
        const remaining = matchesFilter
            .filter(record => !cursor || compare(position(record, order), cursor, order) > 0)
            .sort((a, b) => compare(position(a, order), position(b, order), order));
        const page = remaining.slice(0, pagination?.limit ?? 20);
        const checkpoints = page.map(record => {
            if (includeContext)
                return structuredClone({ ...record, contexts: this.records.get(record.stackId)!.contexts });
            return structuredClone(record);
        });
        return { checkpoints, totalCount: matchesFilter.length, hasNextPage: remaining.length > page.length };
    }
}
