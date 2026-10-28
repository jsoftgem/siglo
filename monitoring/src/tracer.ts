import { trace, Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
    SimpleSpanProcessor,
    BatchSpanProcessor,
    InMemorySpanExporter,
    ReadableSpan
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const providers = new Map<string, NodeTracerProvider>();
const inMemoryExporter = new InMemorySpanExporter();

export interface TelemetryConfig {
    serviceName?: string;
    serviceVersion?: string;
    otlpEndpoint?: string;
    exportToOtlp?: boolean;
}

/**
 * Initializes or retrieves an OpenTelemetry NodeTracerProvider for a given service.
 * Supports distinct service names across microservices and scenarios.
 */
export function initTelemetry(config: TelemetryConfig = {}): Tracer {
    const serviceName = config.serviceName || process.env.OTEL_SERVICE_NAME || 'fluid-func-apm';
    const serviceVersion = config.serviceVersion || '1.0.0';
    const otlpEndpoint = config.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';
    const exportToOtlp = config.exportToOtlp ?? (process.env.NODE_ENV !== 'test');

    let provider = providers.get(serviceName);
    if (!provider) {
        const resource = new Resource({
            [ATTR_SERVICE_NAME]: serviceName,
            [ATTR_SERVICE_VERSION]: serviceVersion,
            'deployment.environment': process.env.NODE_ENV || 'development'
        });

        provider = new NodeTracerProvider({ resource });

        // 1. In-memory processor for terminal visualizer & test assertions
        provider.addSpanProcessor(new SimpleSpanProcessor(inMemoryExporter));

        // 2. OTLP HTTP processor for Jaeger / Grafana Tempo / APM collectors
        if (exportToOtlp) {
            const otlpExporter = new OTLPTraceExporter({
                url: otlpEndpoint,
                timeoutMillis: 1500
            });
            provider.addSpanProcessor(new BatchSpanProcessor(otlpExporter, {
                maxQueueSize: 2048,
                maxExportBatchSize: 512,
                scheduledDelayMillis: 100
            }));
        }

        // Register default global provider if none registered yet
        if (providers.size === 0) {
            provider.register();
        }

        providers.set(serviceName, provider);
    }

    return provider.getTracer(serviceName, serviceVersion);
}

/**
 * Returns recorded in-memory spans.
 */
export function getRecordedSpans(): ReadableSpan[] {
    return inMemoryExporter.getFinishedSpans();
}

/**
 * Clears recorded in-memory spans.
 */
export function clearRecordedSpans(): void {
    inMemoryExporter.reset();
}

/**
 * Flushes active spans from all service providers to OTLP exporter.
 */
export async function flushTelemetry(): Promise<void> {
    for (const provider of providers.values()) {
        try {
            await provider.forceFlush();
        } catch {
            // Gracefully ignore OTLP export failures if collector is offline
        }
    }
}

/**
 * Shuts down all OpenTelemetry providers gracefully.
 */
export async function shutdownTelemetry(): Promise<void> {
    for (const provider of providers.values()) {
        try {
            await provider.shutdown();
        } catch {
            // Gracefully ignore OTLP export failures if collector is offline
        }
    }
    providers.clear();
}

/**
 * Pretty-prints a hierarchical span tree to the console for live terminal observation.
 */
export function printTraceWaterfall(title: string, spans: ReadableSpan[]): void {
    if (spans.length === 0) return;

    console.log(`\n  ┌─ ${title} (${spans.length} spans)`);
    const rootSpan = spans.find(s => !s.parentSpanId) || spans[0];
    const traceId = rootSpan.spanContext().traceId;
    const baseTime = spans.reduce((min, s) => {
        const start = s.startTime[0] * 1000 + s.startTime[1] / 1e6;
        return start < min ? start : min;
    }, Infinity);

    for (const span of spans) {
        const start = span.startTime[0] * 1000 + span.startTime[1] / 1e6;
        const end = span.endTime[0] * 1000 + span.endTime[1] / 1e6;
        const duration = Math.max(0, Math.round(end - start));
        const offset = Math.max(0, Math.round(start - baseTime));

        const isRoot = !span.parentSpanId;
        const indent = isRoot ? '  ├── ' : '  │   ├── ';
        const isError = span.status.code === 2; // SpanStatusCode.ERROR
        const statusBadge = isError ? '❌ ERROR' : '✅ OK';
        const attempt = span.attributes['fluid.step.attempt'];
        const attemptStr = attempt && Number(attempt) > 1 ? ` (retry #${attempt})` : '';

        console.log(
            `${indent}[+${offset.toString().padStart(3, ' ')}ms] ${span.name}${attemptStr} (${duration}ms) [${statusBadge}]`
        );
        if (span.attributes['fluid.step.timeout']) {
            console.log(`  │   │   └─ timeout: ${span.attributes['fluid.step.timeout']}ms`);
        }
        if (span.events && span.events.length > 0) {
            for (const ev of span.events) {
                if (ev.name === 'exception') {
                    console.log(`  │   │   └─ exception: ${(ev.attributes as any)?.['exception.message'] || 'Unknown'}`);
                }
            }
        }
    }
    console.log(`  └──────────────────────────────────────────────────────────`);
    console.log(`  🔍 Jaeger Deep-Link: http://localhost:16686/trace/${traceId}\n`);
}
