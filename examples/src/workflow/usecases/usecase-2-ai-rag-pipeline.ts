import { Step, flow } from 'rivulet';

export interface RagDocumentInput {
    documentId: string;
    sourceUri: string;
    mimeType: string;
    rawText: string;
    claimCheckRef?: string;
}

/**
 * Use Case 2: Multi-Stage AI / LLM & RAG Ingestion Pipeline
 * Flow: extractDocumentText -> chunkContent -> generateEmbeddings -> upsertVectorStore -> indexSearchMetadata
 * Features:
 * - Claim-check pattern: large text extracted and passed with pointer references
 * - Deterministic caching with .cache(60000) on generateEmbeddings to prevent redundant token charges
 * - Fine-grained chunking & vector database upsert
 * - Step.create(...) for idiomatic parameter unwrapping
 */
export function createAiRagPipeline() {
    let embeddingCallCount = 0;

    // Step 1: Extract Document Text
    const extractDocumentText = Step.create('ragExtractDocumentText', async (param: any) => {
        const { documentId, rawText, sourceUri } = param;

        // Clean and normalize text
        const cleanedText = rawText.replace(/\s+/g, ' ').trim();
        const wordCount = cleanedText.split(' ').length;

        return {
            documentId,
            sourceUri,
            cleanedText,
            wordCount,
            extractionStatus: 'SUCCESS'
        };
    })
      .spec('documentId', { require: true })
      .spec('rawText', { require: true });

    // Step 2: Chunk Content
    const chunkContent = Step.create('ragChunkContent', async (param: any) => {
        const text: string = param.cleanedText;
        const chunkSize = 200; // simulated characters per chunk
        const chunks: string[] = [];

        for (let i = 0; i < text.length; i += chunkSize) {
            chunks.push(text.slice(i, i + chunkSize));
        }

        return {
            chunks,
            chunkCount: chunks.length
        };
    });

    // Step 3: Generate Embeddings (Cached for 60 seconds to eliminate redundant LLM API costs)
    const generateEmbeddings = Step.create('ragGenerateEmbeddings', async (param: any) => {
        embeddingCallCount++;
        const chunks: string[] = param.chunks;

        // Simulate generating vector embeddings (e.g., 384-dimension floats)
        const embeddings = chunks.map((chunk, idx) => ({
            chunkId: `chunk_${idx}`,
            text: chunk,
            vector: [0.12, -0.45, 0.88, 0.03, 0.67] // simulated embedding vector
        }));

        return {
            embeddings,
            embeddingCallCount,
            modelUsed: 'text-embedding-3-small'
        };
    }).cache(60000);

    // Step 4: Upsert Vector Store
    const upsertVectorStore = Step.create('ragUpsertVectorStore', async (param: any) => {
        const { documentId, embeddings } = param;

        const vectorIds = embeddings.map((_: any, i: number) => `vec_${documentId}_${i}`);

        return {
            vectorStoreNamespace: 'knowledge_base_v1',
            upsertedCount: vectorIds.length,
            vectorIds
        };
    });

    // Step 5: Index Search Metadata
    const indexSearchMetadata = Step.create('ragIndexSearchMetadata', async (param: any) => {
        const { documentId, vectorIds, wordCount, chunkCount, extractionStatus } = param;

        return {
            ragPipelineStatus: 'INDEXED',
            documentId,
            extractionStatus,
            chunkCount,
            indexedVectors: vectorIds.length,
            totalWordsIndexed: wordCount,
            indexedAt: new Date().toISOString()
        };
    });

    const pipeline = flow(
        extractDocumentText,
        chunkContent,
        generateEmbeddings,
        upsertVectorStore,
        indexSearchMetadata
    );

    return {
        pipeline,
        getEmbeddingCallCount: () => embeddingCallCount
    };
}
