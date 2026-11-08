import { recordInspection, captureInspection, InspectionCapturePolicy, InspectionContent } from '@siglo/core';
import { SigloError, StepTimeoutException, CancellationException } from '@siglo/core';
import { Span } from '@opentelemetry/api';
import { HttpMethod, HttpMetadata } from '../types';
import {
    parseRetryAfter,
    isRetryableStatus,
    isTransientNetworkError,
    calculateBackoffDelay,
    DEFAULT_RETRY_STATUSES,
} from './retry';
import {
    injectTraceHeaders,
    recordRequestSpanAttributes,
    recordResponseSpanAttributes,
    getActiveTraceId,
} from './trace';
import { extractHostInfo } from '../policy/asl-bridge';

export interface ExecuteHttpRequestOptions {
    capture?: InspectionCapturePolicy;
    stepName: string;
    url: string;
    method?: HttpMethod;
    headers?: Record<string, string>;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer';
    retryOnStatus?: number[];
    maxRetries?: number;
    allowNotFound?: boolean;
    timeoutMs?: number;
    signal?: any;
    span?: Span;
    clock?: { now(): number };
    sleep?: (ms: number) => Promise<void>;
    customFetch?: typeof globalThis.fetch;
}

export interface HttpResponseResult<T = any> {
    data: T;
    metadata: HttpMetadata;
    notFound?: boolean;
}

/**
 * Resolves an AbortSignal from a candidate which could be an AbortSignal or a Siglo getter function.
 */
export function resolveAbortSignal(candidate: any): AbortSignal | undefined {
    if (!candidate) return undefined;
    if (typeof candidate === 'function') {
        try {
            const res = candidate();
            if (res && (res instanceof AbortSignal || typeof res.addEventListener === 'function')) {
                return res;
            }
        } catch {
            // Ignore getter call error
        }
        if (
            candidate.val &&
            (candidate.val instanceof AbortSignal || typeof candidate.val.addEventListener === 'function')
        ) {
            return candidate.val;
        }
    }
    if (candidate instanceof AbortSignal || typeof candidate.addEventListener === 'function') {
        return candidate;
    }
    return undefined;
}

/**
 * Builds the full URL including query parameters.
 */
export function buildUrlWithQuery(
    baseUrl: string,
    query?: Record<string, string | number | boolean | undefined>,
): string {
    if (!query || Object.keys(query).length === 0) {
        return baseUrl;
    }

    try {
        const url = new URL(baseUrl);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                url.searchParams.append(key, String(value));
            }
        }
        return url.toString();
    } catch {
        // If not a full URL (e.g. relative), use string concatenation
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                params.append(key, String(value));
            }
        }
        const queryString = params.toString();
        if (!queryString) return baseUrl;
        const separator = baseUrl.includes('?') ? '&' : '?';
        return `${baseUrl}${separator}${queryString}`;
    }
}

/**
 * Formats a cURL command string representation for debugging and observability.
 */
export function generateCurlCommand(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: unknown,
): string {
    const parts: string[] = ['curl', '-X', method.toUpperCase(), `'${url}'`];

    for (const [key, val] of Object.entries(headers)) {
        // Redact Authorization headers or sensitive tokens in cURL string for security
        const sanitizedVal =
            key.toLowerCase() === 'authorization' || key.toLowerCase() === 'proxy-authorization' ? '[REDACTED]' : val;
        parts.push(`-H '${key}: ${sanitizedVal}'`);
    }

    if (body !== undefined && body !== null && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        parts.push(`-d '${bodyStr}'`);
    }

    return parts.join(' ');
}

/**
 * Core resilient HTTP client execution with retry, backoff, tracing, and timeout.
 */
export async function executeHttpRequest<T = any>(options: ExecuteHttpRequestOptions): Promise<HttpResponseResult<T>> {
    const {
        stepName,
        url: rawUrl,
        method = 'GET',
        headers: rawHeaders = {},
        query,
        body,
        responseType = 'json',
        retryOnStatus = [...DEFAULT_RETRY_STATUSES],
        maxRetries = 3,
        allowNotFound = false,
        timeoutMs,
        signal: rawSignal,
        span: customSpan,
        clock,
        sleep: customSleep,
        customFetch,
    } = options;

    const externalSignal = resolveAbortSignal(rawSignal);
    const fetchFn = customFetch || globalThis.fetch;
    const sleepFn = customSleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
    const nowFn = clock ? clock.now.bind(clock) : () => Date.now();

    const finalUrl = buildUrlWithQuery(rawUrl, query);
    const hostInfo = extractHostInfo(finalUrl);

    const normalizedMethod = method.toUpperCase() as HttpMethod;
    const headers: Record<string, string> = { ...rawHeaders };

    // Set default Content-Type for JSON body if not present
    let requestBody: any = undefined;
    if (body !== undefined && body !== null && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
        const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
        if (typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
            if (!hasContentType) {
                headers['Content-Type'] = 'application/json';
            }
            requestBody = JSON.stringify(body);
        } else {
            requestBody = body;
        }
    }

    // W3C Trace context injection
    injectTraceHeaders(headers, customSpan);
    const traceId = getActiveTraceId(customSpan);

    // Record active span attributes
    recordRequestSpanAttributes(normalizedMethod, finalUrl, hostInfo.hostname, customSpan);

    const cUrl = generateCurlCommand(finalUrl, normalizedMethod, headers, body);
    let retryAttempts = 0;
    const startTime = nowFn();

    while (true) {
        const attemptStarted = nowFn();
        let responseObserved = false;
        let inspected = false;
        let responseStatus: number | undefined;
        const content: InspectionContent = {
            ...captureInspection(options.capture, 'requestHeaders', rawHeaders),
            ...captureInspection(options.capture, 'requestBody', body),
        };
        const inspectAttempt = (
            status?: number,
            retryDelayMs?: number,
            retryAfterMs?: number,
            retryDelaySource?: 'retry-after' | 'backoff',
            failed = false,
        ) => {
            inspected = true;
            recordInspection({
                version: 1,
                kind: 'http',
                outcome: !failed && status !== undefined && status < 400 ? 'success' : 'failure',
                method: normalizedMethod,
                url: finalUrl,
                status,
                requestAttempt: retryAttempts + 1,
                content,
                durationMs: Math.max(0, nowFn() - attemptStarted),
                retryDelayMs,
                retryAfterMs,
                retryDelaySource,
                traceId,
                policy: status === undefined ? 'unknown' : 'allowed',
            });
        };
        // Setup cooperative AbortController combining externalSignal and step timeout
        const controller = new AbortController();
        let timeoutId: any = undefined;
        let timedOut = false;

        if (timeoutMs && timeoutMs > 0) {
            timeoutId = setTimeout(() => {
                timedOut = true;
                controller.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        const onExternalAbort = () => {
            controller.abort(externalSignal?.reason);
        };

        if (externalSignal) {
            if (externalSignal.aborted) {
                controller.abort(externalSignal.reason);
            } else if (typeof externalSignal.addEventListener === 'function') {
                externalSignal.addEventListener('abort', onExternalAbort, { once: true });
            }
        }

        try {
            const response = await fetchFn(finalUrl, {
                method: normalizedMethod,
                headers,
                body: requestBody,
                signal: controller.signal,
            });

            if (timeoutId) clearTimeout(timeoutId);
            if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
                externalSignal.removeEventListener('abort', onExternalAbort);
            }

            responseObserved = true;
            responseStatus = response.status;
            recordResponseSpanAttributes(response.status, customSpan);

            const durationMs = nowFn() - startTime;
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((val, key) => {
                responseHeaders[key] = val;
            });

            Object.assign(content, captureInspection(options.capture, 'responseHeaders', responseHeaders));
            const metadata: HttpMetadata = {
                status: response.status,
                statusText: response.statusText,
                durationMs,
                url: finalUrl,
                method: normalizedMethod,
                headers: responseHeaders,
                traceId,
                retryAttempts,
                cUrl,
            };

            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), nowFn);

            // Handle 404 with allowNotFound
            if (response.status === 404 && allowNotFound) {
                inspectAttempt(response.status);
                return {
                    data: null as any,
                    notFound: true,
                    metadata,
                };
            }

            // Check if status is retryable (e.g. 429, 502, 503, 504)
            if (isRetryableStatus(response.status, retryOnStatus)) {
                if (retryAttempts < maxRetries) {
                    const delayMs = retryAfterMs ?? calculateBackoffDelay(retryAttempts + 1);
                    inspectAttempt(
                        response.status,
                        delayMs,
                        retryAfterMs,
                        retryAfterMs === undefined ? 'backoff' : 'retry-after',
                    );
                    retryAttempts++;
                    await sleepFn(delayMs);
                    continue;
                }

                // Exhausted retries on retryable status
                const errorText = await response.text().catch(() => '');
                Object.assign(content, captureInspection(options.capture, 'responseBody', errorText));
                inspectAttempt(response.status, undefined, retryAfterMs);
                const error = new SigloError(
                    `HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`,
                    {
                        stepName,
                        phase: 'action',
                        retryable: true,
                        status: response.status,
                        metadata: { httpMetadata: metadata },
                    },
                );
                (error as any).status = response.status;
                (error as any).httpMetadata = metadata;
                throw error;
            }

            // Handle other non-2xx status codes (fatal client/server errors)
            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                Object.assign(content, captureInspection(options.capture, 'responseBody', errorText));
                inspectAttempt(response.status, undefined, retryAfterMs);
                const error = new SigloError(
                    `HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`,
                    {
                        stepName,
                        phase: 'action',
                        retryable: false,
                        status: response.status,
                        metadata: { httpMetadata: metadata },
                    },
                );
                (error as any).status = response.status;
                (error as any).httpMetadata = metadata;
                throw error;
            }

            // Parse successful response body
            let parsedData: any;
            if (response.status === 204) {
                parsedData = null;
            } else if (responseType === 'text') {
                parsedData = await response.text();
            } else if (responseType === 'blob') {
                parsedData = await response.blob();
            } else if (responseType === 'arrayBuffer') {
                parsedData = await response.arrayBuffer();
            } else {
                // Default: 'json'
                const text = await response.text();
                Object.assign(content, captureInspection(options.capture, 'responseBody', text));
                parsedData = text.trim().length > 0 ? JSON.parse(text) : {};
            }

            Object.assign(content, captureInspection(options.capture, 'responseBody', parsedData));
            inspectAttempt(response.status, undefined, retryAfterMs);
            return {
                data: parsedData,
                metadata,
            };
        } catch (err: any) {
            const transportRetryDelay =
                !responseObserved &&
                !timedOut &&
                !externalSignal?.aborted &&
                err?.name !== 'AbortError' &&
                !err?.message?.includes('aborted') &&
                !(err instanceof SigloError) &&
                isTransientNetworkError(err) &&
                retryAttempts < maxRetries
                    ? calculateBackoffDelay(retryAttempts + 1)
                    : undefined;
            if (!inspected)
                inspectAttempt(
                    responseStatus,
                    transportRetryDelay,
                    undefined,
                    transportRetryDelay === undefined ? undefined : 'backoff',
                    true,
                );
            if (timeoutId) clearTimeout(timeoutId);
            if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
                externalSignal.removeEventListener('abort', onExternalAbort);
            }

            if (timedOut) {
                throw new StepTimeoutException(stepName, timeoutMs || 0, {
                    stepName,
                    phase: 'action',
                    cause: err,
                });
            }

            if (err?.name === 'AbortError' || err?.message?.includes('aborted') || externalSignal?.aborted) {
                throw new CancellationException(err?.message || 'HTTP request aborted', {
                    stepName,
                    phase: 'action',
                    cause: err,
                });
            }

            // If already a SigloError, rethrow
            if (err instanceof SigloError) {
                throw err;
            }

            // Check if transient network transport error
            if (isTransientNetworkError(err) && retryAttempts < maxRetries) {
                retryAttempts++;
                const delayMs = transportRetryDelay ?? calculateBackoffDelay(retryAttempts);
                await sleepFn(delayMs);
                continue;
            }

            // Fatal network or unhandled failure
            const durationMs = nowFn() - startTime;
            const metadata: HttpMetadata = {
                status: 0,
                statusText: err?.code || 'FETCH_ERROR',
                durationMs,
                url: finalUrl,
                method: normalizedMethod,
                headers: {},
                traceId,
                retryAttempts,
                cUrl,
            };

            const error = new SigloError(`HTTP request failed to ${finalUrl}: ${err?.message || err}`, {
                stepName,
                phase: 'action',
                retryable: isTransientNetworkError(err),
                cause: err,
                metadata: { httpMetadata: metadata },
            });
            (error as any).httpMetadata = metadata;
            throw error;
        }
    }
}
