import { CancellationException } from '@siglo/core';

/** Node request close also fires after a normal body read; response close detects a lost client. */
export function requestCancellation(request: any, response: any, source?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort(new CancellationException('Client connection closed'));
    const forward = () => controller.abort(source?.reason);
    const requestClosed = () => {
        if (request.aborted || request.complete === false) abort();
    };
    const responseClosed = () => {
        if (!response.writableFinished) abort();
    };
    request?.on?.('aborted', abort);
    request?.on?.('close', requestClosed);
    response?.on?.('close', responseClosed);
    source?.addEventListener('abort', forward, { once: true });
    if (source?.aborted) forward();
    if (request?.aborted || response?.destroyed) abort();
    return {
        signal: controller.signal,
        cleanup() {
            request?.removeListener?.('aborted', abort);
            request?.removeListener?.('close', requestClosed);
            response?.removeListener?.('close', responseClosed);
            source?.removeEventListener('abort', forward);
        },
    };
}
