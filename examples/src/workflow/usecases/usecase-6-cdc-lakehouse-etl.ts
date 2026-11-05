import { Step, flow } from '@siglo/core';

export interface DebeziumCdcEvent {
    op: 'c' | 'u' | 'd'; // create, update, delete
    source: {
        db: string;
        table: string;
        lsn: number;
        ts_ms: number;
    };
    before: Record<string, any> | null;
    after: Record<string, any> | null;
}

/**
 * Use Case 6: CDC (Change Data Capture) & Data Lakehouse ETL
 * Flow: captureDbEvent -> transformSchema -> enrichFromCustomerService -> deduplicate -> sinkToWarehouse
 * Features:
 * - Schema translator mapping legacy snake_case database rows to camelCase Lakehouse schemas
 * - Deduplication via LSN / binlog coordinate cache keys
 * - Dimension enrichment and analytical micro-batching
 * - Step.create(...) for idiomatic POJO parameter unwrapping
 */
export function createCdcLakehousePipeline() {
    const seenLsns = new Set<number>();

    // Step 1: Capture DB Event & Validate Debezium Envelope
    const captureDbEvent = Step.create('cdcCaptureDbEvent', async (param: any) => {
        const { op, source } = param;

        const operationName = op === 'c' ? 'INSERT' : op === 'u' ? 'UPDATE' : 'DELETE';

        return {
            cdcCaptured: true,
            operation: operationName,
            tableName: source.table,
            lsn: source.lsn,
            capturedTimestamp: source.ts_ms
        };
    })
      .spec('op', { require: true })
      .spec('source', { require: true });

    // Step 2: Transform Schema (Translate legacy SQL row names to standardized Lakehouse model)
    const transformSchema = Step.create('cdcTransformSchema', async (param: any) => {
        const after = param.after || {};
        const operation = param.operation;

        // Schema translator: legacy relational columns -> standardized analytical schema
        const transformedRow = {
            userId: after.usr_id_pk ?? null,
            emailAddress: after.usr_email_addr ?? null,
            firstName: after.first_nm ?? null,
            lastName: after.last_nm ?? null,
            accountBalance: after.acct_bal_amt ? Number(after.acct_bal_amt) : 0,
            cdcOperation: operation,
            isDeleted: operation === 'DELETE'
        };

        return {
            transformedRow,
            schemaVersion: 'lakehouse.v2'
        };
    });

    // Step 3: Enrich from Customer Service Dimensions
    const enrichFromCustomerService = Step.create('cdcEnrichCustomer', async (param: any) => {
        const row = param.transformedRow;

        // Enriched metadata
        const enrichedRow = {
            ...row,
            customerTier: row.accountBalance >= 5000 ? 'GOLD' : 'STANDARD',
            enrichedAt: Date.now()
        };

        return {
            enrichedRow
        };
    });

    // Step 4: Deduplicate via LSN Check
    const deduplicate = Step.create('cdcDeduplicate', async (param: any) => {
        const lsn: number = param.lsn;
        const isDuplicate = seenLsns.has(lsn);

        if (!isDuplicate) {
            seenLsns.add(lsn);
        }

        return {
            isDuplicate,
            dedupKey: `cdc:lsn:${lsn}`
        };
    });

    // Step 5: Sink to Lakehouse Warehouse (Parquet/Iceberg format)
    const sinkToWarehouse = Step.create('cdcSinkToWarehouse', async (param: any) => {
        const { enrichedRow, transformedRow, tableName, isDuplicate, lsn, operation } = param;

        if (isDuplicate) {
            return {
                cdcPipelineStatus: 'SKIPPED_DUPLICATE',
                lsn,
                isDuplicate: true,
                cdcCaptured: true,
                reason: 'Event already committed to lakehouse partition'
            };
        }

        const partitionPath = `warehouse/iceberg/${tableName}/date=${new Date().toISOString().split('T')[0]}`;

        return {
            cdcPipelineStatus: 'COMMITTED',
            cdcCaptured: true,
            operation,
            transformedRow,
            enrichedRow,
            isDuplicate: false,
            targetTable: tableName,
            partitionPath,
            committedLsn: lsn,
            committedRecord: enrichedRow
        };
    });

    return flow(
        captureDbEvent,
        transformSchema,
        enrichFromCustomerService,
        deduplicate,
        sinkToWarehouse
    );
}
