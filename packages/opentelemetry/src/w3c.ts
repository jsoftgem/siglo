import {
    context,
    propagation,
    Span,
    trace,
    Context,
    defaultTextMapSetter,
    defaultTextMapGetter,
} from '@opentelemetry/api';
import { W3CTraceHeaders } from './types';

/**
 * Injects the active or specified OpenTelemetry context into a headers / carrier object.
 */
export function injectTraceContext(
    carrier: Record<string, string> = {},
    ctx: Context = context.active(),
): Record<string, string> {
    propagation.inject(ctx, carrier, defaultTextMapSetter);
    return carrier;
}

/**
 * Extracts an OpenTelemetry context from a headers / carrier object (e.g., from HTTP or Kafka headers).
 */
export function extractTraceContext(
    carrier: Record<string, string | undefined>,
    ctx: Context = context.active(),
): Context {
    const sanitizedCarrier: Record<string, string> = {};
    for (const [key, val] of Object.entries(carrier)) {
        if (typeof val === 'string') {
            sanitizedCarrier[key.toLowerCase()] = val;
        }
    }
    return propagation.extract(ctx, sanitizedCarrier, defaultTextMapGetter);
}

/**
 * Extracts W3C traceparent and tracestate from an active Span or SpanContext.
 */
export function getTraceHeaders(span?: Span): W3CTraceHeaders {
    const targetSpan = span || trace.getActiveSpan();
    if (!targetSpan) {
        return {};
    }
    const spanCtx = targetSpan.spanContext();
    if (!spanCtx || !spanCtx.traceId) {
        return {};
    }

    const flags = (spanCtx.traceFlags || 0).toString(16).padStart(2, '0');
    const traceparent = `00-${spanCtx.traceId}-${spanCtx.spanId}-${flags}`;
    const headers: W3CTraceHeaders = { traceparent };
    if (spanCtx.traceState) {
        headers.tracestate = spanCtx.traceState.serialize();
    }
    return headers;
}
