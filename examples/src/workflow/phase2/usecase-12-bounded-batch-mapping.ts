import { Step, flow, map } from 'fluid-func';

export interface DocumentItem {
    docId: string;
    title: string;
    category: string;
    content: string;
}

export interface BatchIngestionInput {
    batchId: string;
    department: string;
    documents: DocumentItem[];
}

export interface WorkerConcurrencyTracker {
    current: number;
    peak: number;
    processedIds: string[];
}

/**
 * Use Case 12: High-Throughput Document Batch Processing with Bounded Worker Pool
 * Features demonstrated:
 * - map((ctx) => ctx.documents, processStep, { concurrency: N, stopOnError: false })
 * - Controlled worker concurrency to avoid overloading external embedding APIs
 * - Order preservation across mapped items
 * - Accumulation of mapped outputs into context
 */
export function createBoundedBatchIngestionPipeline(tracker: WorkerConcurrencyTracker = { current: 0, peak: 0, processedIds: [] }) {
    // Worker step executed for each item in the documents collection
    const indexDocumentWorker = Step.create('indexDocumentWorker', async (param: any) => {
        tracker.current++;
        if (tracker.current > tracker.peak) {
            tracker.peak = tracker.current;
        }

        const item: DocumentItem = param.item || param;
        const title = item.title || 'Untitled';
        const docId = item.docId || 'unknown';
        const content = item.content || '';

        // Simulate async embedding and vector storage
        await new Promise((r) => setTimeout(r, 10));

        tracker.processedIds.push(docId);
        tracker.current--;

        return {
            docId,
            title,
            vectorDimensions: 1536,
            tokenCount: Math.ceil(content.length / 4) || 1,
            indexedAt: Date.now(),
            status: 'INDEXED'
        };
    }).modern();

    // Step 1: Pre-validation of Batch Metadata
    const validateBatch = Step.create('validateBatch', async (param: any) => {
        const documents: DocumentItem[] = param.documents;
        if (!documents || documents.length === 0) {
            throw new Error('Batch has no documents');
        }

        return {
            totalDocumentCount: documents.length,
            batchInitialized: true
        };
    }).modern();

    // Step 2: Bounded Concurrency Mapping (Worker pool of max 3 workers)
    const mapDocuments = map((ctx: any) => ctx.documents, indexDocumentWorker, {
        concurrency: 3,
        stopOnError: false
    });

    // Step 3: Summarize and Publish Catalog
    const summarizeCatalog = Step.create('summarizeCatalog', async (param: any) => {
        const mappedItems: any[] = param.items || [];
        const totalTokens = mappedItems.reduce((acc, doc) => acc + (doc.tokenCount || 0), 0);

        return {
            pipelineStatus: 'COMPLETED',
            batchId: param.batchId,
            department: param.department,
            totalIndexed: mappedItems.length,
            totalTokens,
            catalogSummary: `Ingested ${mappedItems.length} documents (${totalTokens} tokens) with peak concurrency ${tracker.peak}`
        };
    }).modern();

    return flow(
        validateBatch,
        mapDocuments,
        summarizeCatalog
    );
}
