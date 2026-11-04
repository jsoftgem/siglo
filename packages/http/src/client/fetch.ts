import { SigloError, StepTimeoutException, CancellationException } from 'siglo';
import { Span } from '@opentelemetry/api';
import { HttpMethod, HttpMetadata } from '../types';
import {
  parseRetryAfter,
  isRetryableStatus,
  isTransientNetworkError,
  calculateBackoffDelay,
  DEFAULT_RETRY_STATUSES
} from './retry';
import {
  injectTraceHeaders,
  recordRequestSpanAttributes,
  recordResponseSpanAttributes,
  getActiveTraceId
} from './trace';
import { extractHostInfo } from '../policy/asl-bridge';

export interface ExecuteHttpRequestOptions {
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
    if (candidate.val && (candidate.val instanceof AbortSignal || typeof candidate.val.addEventListener === 'function')) {
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
  query?: Record<string, string | number | boolean | undefined>
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
  body: unknown
): string {
  const parts: string[] = ['curl', '-X', method.toUpperCase(), `'${url}'`];

  for (const [key, val] of Object.entries(headers)) {
    // Redact Authorization headers or sensitive tokens in cURL string for security
    const sanitizedVal =
      key.toLowerCase() === 'authorization' || key.toLowerCase() === 'proxy-authorization'
        ? '[REDACTED]'
        : val;
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
export async function executeHttpRequest<T = any>(
  options: ExecuteHttpRequestOptions
): Promise<HttpResponseResult<T>> {
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
    customFetch
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
        signal: controller.signal
      });

      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }

      recordResponseSpanAttributes(response.status, customSpan);

      const durationMs = nowFn() - startTime;
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        responseHeaders[key] = val;
      });

      const metadata: HttpMetadata = {
        status: response.status,
        statusText: response.statusText,
        durationMs,
        url: finalUrl,
        method: normalizedMethod,
        headers: responseHeaders,
        traceId,
        retryAttempts,
        cUrl
      };

      // Handle 404 with allowNotFound
      if (response.status === 404 && allowNotFound) {
        return {
          data: null as any,
          notFound: true,
          metadata
        };
      }

      // Check if status is retryable (e.g. 429, 502, 503, 504)
      if (isRetryableStatus(response.status, retryOnStatus)) {
        if (retryAttempts < maxRetries) {
          retryAttempts++;
          let delayMs: number;

          if (response.status === 429) {
            const retryAfterHeader = response.headers.get('retry-after');
            const parsed = parseRetryAfter(retryAfterHeader, nowFn);
            delayMs = parsed !== undefined ? parsed : calculateBackoffDelay(retryAttempts);
          } else {
            delayMs = calculateBackoffDelay(retryAttempts);
          }

          await sleepFn(delayMs);
          continue;
        }

        // Exhausted retries on retryable status
        const errorText = await response.text().catch(() => '');
        const error = new SigloError(
          `HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`,
          {
            stepName,
            phase: 'action',
            retryable: true,
            status: response.status,
            metadata: { httpMetadata: metadata }
          }
        );
        (error as any).status = response.status;
        (error as any).httpMetadata = metadata;
        throw error;
      }

      // Handle other non-2xx status codes (fatal client/server errors)
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const error = new SigloError(
          `HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`,
          {
            stepName,
            phase: 'action',
            retryable: false,
            status: response.status,
            metadata: { httpMetadata: metadata }
          }
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
        parsedData = text.trim().length > 0 ? JSON.parse(text) : {};
      }

      return {
        data: parsedData,
        metadata
      };
    } catch (err: any) {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }

      if (timedOut) {
        throw new StepTimeoutException(stepName, timeoutMs || 0, {
          stepName,
          phase: 'action',
          cause: err
        });
      }

      if (err?.name === 'AbortError' || err?.message?.includes('aborted') || externalSignal?.aborted) {
        throw new CancellationException(err?.message || 'HTTP request aborted', {
          stepName,
          phase: 'action',
          cause: err
        });
      }

      // If already a SigloError, rethrow
      if (err instanceof SigloError) {
        throw err;
      }

      // Check if transient network transport error
      if (isTransientNetworkError(err) && retryAttempts < maxRetries) {
        retryAttempts++;
        const delayMs = calculateBackoffDelay(retryAttempts);
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
        cUrl
      };

      const error = new SigloError(`HTTP request failed to ${finalUrl}: ${err?.message || err}`, {
        stepName,
        phase: 'action',
        retryable: isTransientNetworkError(err),
        cause: err,
        metadata: { httpMetadata: metadata }
      });
      (error as any).httpMetadata = metadata;
      throw error;
    }
  }
}
