import { context, propagation, trace, defaultTextMapSetter, SpanStatusCode, type Span } from '@opentelemetry/api';

export type SpanLike =
    | Span
    | {
          spanContext?:
              | (() => {
                    traceId?: string;
                    spanId?: string;
                    traceFlags?: number;
                    traceState?: { serialize?: () => string };
                })
              | { traceId?: string; spanId?: string; traceFlags?: number; traceState?: { serialize?: () => string } };
          setAttribute?: (key: string, value: string | number | boolean) => unknown;
          setStatus?: (status: { code: SpanStatusCode; message?: string }) => unknown;
          traceId?: string;
      };

export interface TraceContextHeaders {
    traceparent?: string;
    tracestate?: string;
    [key: string]: string | undefined;
}

/**
 * Injects W3C distributed trace context (traceparent and tracestate) into request headers
 * from the active OpenTelemetry span and context.
 */
export function injectTraceHeaders(
    carrier: Record<string, string> = {},
    customSpan?: SpanLike,
): Record<string, string> {
    const activeCtx = context.active();
    try {
        propagation.inject(activeCtx, carrier, defaultTextMapSetter);
    } catch {
        // If propagation fails, continue to spanContext fallback
    }

    const targetSpan = customSpan || trace.getActiveSpan();
    if (targetSpan) {
        try {
            const spanCtx =
                typeof targetSpan.spanContext === 'function' ? targetSpan.spanContext() : targetSpan.spanContext;

            if (spanCtx && spanCtx.traceId && !carrier['traceparent']) {
                const flags = (spanCtx.traceFlags ?? 0).toString(16).padStart(2, '0');
                const spanId = spanCtx.spanId || '0000000000000000';
                carrier['traceparent'] = `00-${spanCtx.traceId}-${spanId}-${flags}`;
                if (spanCtx.traceState) {
                    carrier['tracestate'] =
                        typeof spanCtx.traceState.serialize === 'function'
                            ? spanCtx.traceState.serialize()
                            : String(spanCtx.traceState);
                }
            }
        } catch {
            // Ignore span context extraction error
        }
    }

    return carrier;
}

/**
 * Attaches standard HTTP semantic convention attributes to the active OpenTelemetry span.
 */
export function recordRequestSpanAttributes(
    method: string,
    url: string,
    serverAddress: string,
    customSpan?: SpanLike,
): void {
    const activeSpan = customSpan || trace.getActiveSpan();
    if (activeSpan && typeof activeSpan.setAttribute === 'function') {
        try {
            activeSpan.setAttribute('http.request.method', method.toUpperCase());
            activeSpan.setAttribute('url.full', url);
            activeSpan.setAttribute('server.address', serverAddress);
        } catch {
            // Ignore attribute recording errors
        }
    }
}

/**
 * Attaches standard response semantic convention attributes to the active OpenTelemetry span.
 */
export function recordResponseSpanAttributes(statusCode: number, customSpan?: SpanLike): void {
    const activeSpan = customSpan || trace.getActiveSpan();
    if (activeSpan && typeof activeSpan.setAttribute === 'function') {
        try {
            activeSpan.setAttribute('http.response.status_code', statusCode);
            if (statusCode >= 400 && typeof activeSpan.setStatus === 'function') {
                activeSpan.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: `HTTP error status ${statusCode}`,
                });
            }
        } catch {
            // Ignore attribute recording errors
        }
    }
}

/**
 * Extracts current active traceId if present.
 */
export function getActiveTraceId(customSpan?: SpanLike): string | undefined {
    const activeSpan = customSpan || trace.getActiveSpan();
    if (activeSpan) {
        try {
            if (typeof activeSpan.spanContext === 'function') {
                return activeSpan.spanContext()?.traceId;
            }
            if (activeSpan.spanContext && typeof activeSpan.spanContext === 'object') {
                return activeSpan.spanContext.traceId;
            }
            if ('traceId' in activeSpan && typeof activeSpan.traceId === 'string') {
                return activeSpan.traceId;
            }
        } catch {
            return undefined;
        }
    }
    return undefined;
}
