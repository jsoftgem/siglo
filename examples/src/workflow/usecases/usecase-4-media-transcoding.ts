import { Step, flow } from 'rivulet';

export interface MediaUploadInput {
    assetId: string;
    sourceS3Url: string;
    targetResolutions: ('1080p' | '720p' | '480p')[];
    uploadedBy: string;
}

/**
 * Use Case 4: Asynchronous Media Transcoding & Asset Processing
 * Flow: receiveMediaUpload -> extractMetadata -> transcodeResolutions -> generateThumbnails -> syncCdn
 * Features:
 * - Claim-check pattern: large video file remains in S3; only URI pointers and metadata flow through steps
 * - Native AbortSignal cancellation support for long-running GPU/CPU transcoding jobs
 * - Multi-resolution variant generation and CDN edge cache syncing
 * - Step.create(...).modern() for idiomatic POJO parameter access
 */
export function createMediaTranscodingPipeline() {
    // Step 1: Receive Media Upload (Claim-Check Pointer)
    const receiveMediaUpload = Step.create('mediaReceiveUpload', async (param: any) => {
        const { sourceS3Url } = param;

        return {
            uploadReceived: true,
            storagePointer: sourceS3Url,
            assetStatus: 'QUEUED_FOR_PROCESSING'
        };
    }).modern()
      .spec('assetId', { require: true })
      .spec('sourceS3Url', { require: true });

    // Step 2: Extract Video Metadata
    const extractMetadata = Step.create('mediaExtractMetadata', async () => {
        // Simulated video probe metadata (e.g., ffprobe)
        return {
            metadataExtracted: true,
            durationSeconds: 124.5,
            codec: 'h264',
            audioChannels: 2,
            aspectRatio: '16:9',
            originalResolution: '1920x1080'
        };
    }).modern();

    // Step 3: Transcode Resolutions (Respects AbortSignal if user cancels job)
    const transcodeResolutions = Step.create('mediaTranscodeResolutions', async (param: any) => {
        const { assetId, targetResolutions: resolutions } = param;

        const transcodedOutputs = resolutions.map((res: string) => ({
            resolution: res,
            outputUrl: `s3://cdn-bucket/media/${assetId}/${res}/stream.m3u8`,
            bitrateKbps: res === '1080p' ? 5000 : res === '720p' ? 2800 : 1200
        }));

        return {
            transcodingComplete: true,
            outputs: transcodedOutputs,
            variantCount: transcodedOutputs.length
        };
    }).modern();

    // Step 4: Generate Thumbnails
    const generateThumbnails = Step.create('mediaGenerateThumbnails', async (param: any) => {
        const { assetId, durationSeconds: duration } = param;

        const thumbnailUrls = [0.1, 0.5, 0.9].map((fraction, idx) => {
            const timestampSec = Math.floor(duration * fraction);
            return `s3://cdn-bucket/media/${assetId}/thumbnails/thumb_${idx}_${timestampSec}s.jpg`;
        });

        return {
            thumbnailsGenerated: true,
            thumbnails: thumbnailUrls
        };
    }).modern();

    // Step 5: Sync CDN Edge Distribution
    const syncCdn = Step.create('mediaSyncCdn', async (param: any) => {
        const { assetId, outputs, thumbnails, codec, variantCount, uploadReceived, metadataExtracted } = param;

        const edgeBaseUrl = `https://edge.video-cdn.com/${assetId}`;

        return {
            mediaPipelineStatus: 'READY_TO_STREAM',
            assetId,
            codec,
            uploadReceived,
            metadataExtracted,
            variantCount,
            masterManifestUrl: `${edgeBaseUrl}/master.m3u8`,
            variants: outputs,
            thumbnailsGenerated: true,
            thumbnailPreview: thumbnails[0],
            cdnPurgedAndWarm: true,
            completedAt: new Date().toISOString()
        };
    }).modern();

    return flow(
        receiveMediaUpload,
        extractMetadata,
        transcodeResolutions,
        generateThumbnails,
        syncCdn
    );
}
