import { AsyncResource } from 'node:async_hooks';
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { extractTraceContext } from '@siglo/opentelemetry';
import type { EachMessageHandler } from 'kafkajs';

/** Create at SDK startup so batch timers cannot carry a business step's egress policy into export. */
export function isolateTelemetryExporter(exporter: SpanExporter): SpanExporter {
    const scope = new AsyncResource('kafka-apm-export');
    return {
        export: (spans, callback) => scope.runInAsyncScope(() => exporter.export(spans, callback)),
        shutdown: async () => {
            try {
                await exporter.shutdown();
            } finally {
                scope.emitDestroy();
            }
        },
    };
}

/** Opt in through the APM Compose overlay; the routing tutorial also runs without a collector. */
export function startTelemetry(serviceName: string) {
    if (
        process.env.OTEL_TRACES_EXPORTER === 'none' ||
        !(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
    ) {
        return undefined;
    }
    const provider = new NodeTracerProvider({
        resource: resourceFromAttributes({ 'service.name': serviceName, 'service.version': '1.2.0' }),
        spanProcessors: [new BatchSpanProcessor(isolateTelemetryExporter(new OTLPTraceExporter()))],
    });
    provider.register();
    return { tracer: provider.getTracer('zero-code-apm-dashboards'), shutdown: () => provider.shutdown() };
}

/** Trace adapter handling as well as workflows, including validation and deduplicated records. */
export function traceKafkaHandler(handler: EachMessageHandler): EachMessageHandler {
    return async payload => {
        const headers = payload.message.headers;
        const carrier = {
            traceparent: String(headers?.traceparent || ''),
            tracestate: String(headers?.tracestate || ''),
        };
        // A record without trace headers starts a fresh trace, even if the caller has an active span.
        const parent = context.with(ROOT_CONTEXT, () => extractTraceContext(carrier));
        await context.with(parent, () =>
            trace.getTracer('zero-code-apm-dashboards').startActiveSpan(
                'kafka:process apm.orders',
                {
                    kind: SpanKind.CONSUMER,
                    attributes: {
                        'messaging.system': 'kafka',
                        'messaging.destination.name': payload.topic,
                        'messaging.kafka.partition': payload.partition,
                        'messaging.kafka.offset': payload.message.offset,
                    },
                },
                async span => {
                    try {
                        await handler(payload);
                        span.setStatus({ code: SpanStatusCode.OK });
                    } catch (error) {
                        span.recordException(error instanceof Error ? error : String(error));
                        span.setStatus({ code: SpanStatusCode.ERROR });
                        throw error;
                    } finally {
                        span.end();
                    }
                },
            ),
        );
    };
}
