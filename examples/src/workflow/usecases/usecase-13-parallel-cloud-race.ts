import { Step, flow, parallel, race, allSettled } from '@siglo/core';

export interface CloudAssetInput {
    assetId: string;
    fileName: string;
    byteSize: number;
    mimeType: string;
}

/**
 * Use Case 13: Latency-Optimized Multi-Cloud Storage Race & Parallel Replication
 * Features demonstrated:
 * - race(edgeA, edgeB): Competitive latency race with AbortSignal cancellation
 * - parallel(s3, gcp, azure, { mergeStrategy: 'deep' }): Concurrent branch execution with deep context merge
 * - allSettled(analytics, notification): Non-blocking telemetry collection
 */
export function createMultiCloudReplicationPipeline() {
    const getSignal = (param: any) => (typeof param.$signal === 'function' ? param.$signal() : param.$signal);

    // Edge Gateway 1: Primary US Edge (faster simulation)
    const usEdgeGateway = Step.create('usEdgeGateway', async (param: any) => {
        const signal = getSignal(param);
        // Respond fast (10ms)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 10);
            signal?.addEventListener?.('abort', () => {
                clearTimeout(timer);
                reject(new Error('Aborted'));
            });
        });

        return {
            selectedEdge: 'US_EAST_EDGE',
            edgeLatencyMs: 10,
            ingressUrl: `https://us-east.edge.cloud/upload/${param.assetId}`,
        };
    });

    // Edge Gateway 2: Secondary EU Edge (slower simulation)
    const euEdgeGateway = Step.create('euEdgeGateway', async (param: any) => {
        const signal = getSignal(param);
        // Respond slower (80ms)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 80);
            signal?.addEventListener?.('abort', () => {
                clearTimeout(timer);
                reject(new Error('Aborted'));
            });
        });

        return {
            selectedEdge: 'EU_CENTRAL_EDGE',
            edgeLatencyMs: 80,
            ingressUrl: `https://eu-central.edge.cloud/upload/${param.assetId}`,
        };
    });

    // Parallel Branch 1: Replicate to AWS S3
    const replicateToS3 = Step.create('replicateToS3', async (param: any) => {
        return {
            cloudReplicas: {
                aws: {
                    bucket: 'prod-media-us-east-1',
                    s3Uri: `s3://prod-media-us-east-1/${param.assetId}/${param.fileName}`,
                    status: 'SYNCED',
                },
            },
        };
    });

    // Parallel Branch 2: Replicate to Google Cloud Storage (GCS)
    const replicateToGcs = Step.create('replicateToGcs', async (param: any) => {
        return {
            cloudReplicas: {
                gcp: {
                    bucket: 'prod-media-europe-west3',
                    gcsUri: `gs://prod-media-europe-west3/${param.assetId}/${param.fileName}`,
                    status: 'SYNCED',
                },
            },
        };
    });

    // Parallel Branch 3: Replicate to Azure Blob Storage
    const replicateToAzure = Step.create('replicateToAzure', async (param: any) => {
        return {
            cloudReplicas: {
                azure: {
                    container: 'prodmediaeastus',
                    blobUri: `https://prodmediaeastus.blob.core.windows.net/${param.assetId}/${param.fileName}`,
                    status: 'SYNCED',
                },
            },
        };
    });

    // Telemetry Step 1: Analytics Hook
    const logReplicationAnalytics = Step.create('logReplicationAnalytics', async (param: any) => {
        return {
            analyticsLogged: true,
            bytesRecorded: param.byteSize,
        };
    });

    // Telemetry Step 2: Push Audit Event
    const pushReplicationAudit = Step.create('pushReplicationAudit', async () => {
        return {
            auditPushed: true,
            timestamp: Date.now(),
        };
    });

    // Final Assembly Step
    const assembleReceipt = Step.create('assembleReceipt', async (param: any) => {
        return {
            pipelineStatus: 'REPLICATED',
            assetId: param.assetId,
            selectedEdge: param.selectedEdge,
            replicas: param.cloudReplicas,
        };
    });

    return flow(
        // 1. Race to discover lowest latency edge gateway
        race(usEdgeGateway, euEdgeGateway),

        // 2. Parallel fan-out to 3 clouds with deep merge strategy
        parallel(replicateToS3, replicateToGcs, replicateToAzure, {
            mergeStrategy: 'deep',
        }),

        // 3. Non-blocking allSettled background hooks
        allSettled([logReplicationAnalytics, pushReplicationAudit]),

        // 4. Final verification and receipt
        assembleReceipt,
    );
}
