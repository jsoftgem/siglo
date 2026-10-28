import { Tracer, Span } from '@opentelemetry/api';

export interface RivuletTelemetryOptions {
    tracer?: Tracer;
    serviceName?: string;
    workflowName?: string;
    workflowVersion?: string;
    allowNamespace?: boolean;
    allowContextFields?: string[];
    redactHook?: (key: string, value: unknown) => unknown;
}

export interface W3CTraceHeaders {
    traceparent?: string;
    tracestate?: string;
}

export interface ActiveExecutionSpan {
    workflowSpan: Span;
    stepSpans: Map<string, Span>;
}

