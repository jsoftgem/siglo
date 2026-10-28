import { Step, flow } from 'rivulet';
import { createBullMQProcessor } from '@rivulet/bullmq';
import { createSqsBatchHandler } from '@rivulet/sqs';

export interface ImageResizeJobInput {
    jobId: string;
    imageUrl: string;
    targetWidth: number;
    targetHeight: number;
    format: 'webp' | 'jpeg' | 'png';
    tenant?: string;
}

/**
 * Use Case 20: Resilient Asynchronous Queue Worker & Dead-Letter Handling
 * Adapters demonstrated: @rivulet/bullmq & @rivulet/sqs
 * Features demonstrated:
 * - BullMQ queue processor with automatic progress reporting and job completion
 * - SQS batch consumer with Partial Batch Failure handling (batchItemFailures)
 * - Namespace extraction from BullMQ data and SQS message attributes
 * - Error isolation so individual failed messages don't block entire batches
 */
export function createImageOptimizationWorkflow() {
    // Step 1: Download & Inspect Image Asset
    const inspectImage = Step.create('inspectImage', async (param: any) => {
        const { jobId, imageUrl, targetWidth, targetHeight } = param;
        if (!imageUrl) {
            throw new Error('InvalidImageUrl: imageUrl cannot be empty');
        }
        return {
            jobId,
            imageUrl,
            targetWidth: targetWidth || 800,
            targetHeight: targetHeight || 600,
            originalSize: 4194304, // 4MB
            dimensions: { width: 1920, height: 1080 }
        };
    }).modern();

    // Step 2: Resize & Compress
    const processCompression = Step.create('processCompression', async (param: any) => {
        const { jobId, format, targetWidth, targetHeight } = param;
        const finalFormat = format || 'webp';
        const compressedSize = 262144; // 256KB
        const outputUri = `s3://cdn-assets/optimized/${jobId}_${targetWidth}x${targetHeight}.${finalFormat}`;

        return {
            outputUri,
            compressedSize,
            compressionRatio: '93.75%',
            status: 'COMPLETED'
        };
    }).modern();

    return flow(inspectImage, processCompression);
}

/**
 * Creates BullMQ worker processor for async image optimization.
 */
export function createBullMqImageProcessor(workflow = createImageOptimizationWorkflow()) {
    return createBullMQProcessor(workflow, {
        input: (job: any) => job.data,
        output: async (result: any, job: any) => {
            if (typeof job.updateProgress === 'function') {
                await job.updateProgress(100);
            }
            return {
                jobId: job.id,
                outputUri: typeof result.outputUri === 'function' ? result.outputUri() : result.outputUri,
                compressionRatio: typeof result.compressionRatio === 'function' ? result.compressionRatio() : result.compressionRatio
            };
        }
    });
}

/**
 * Creates SQS Batch handler supporting AWS SQS Partial Batch Responses.
 */
export function createSqsImageBatchConsumer(workflow = createImageOptimizationWorkflow()) {
    return createSqsBatchHandler(workflow);
}
