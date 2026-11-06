import { createServer } from 'node:http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { networkPolicyStorage, ensureNetworkInterceptorsInstalled } from '@siglo/core';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createKafkaMessageHandler } from '@siglo/kafka';
import type { EachMessagePayload, KafkaMessage } from 'kafkajs';
import { publishScenario } from './publish';
import { createOrderRoutingWorkflow, validateOrderEvent } from './workflow';
import { isolateTelemetryExporter, traceKafkaHandler } from './telemetry';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
after(() => provider.shutdown());

for (const name of ['standard', 'gift', 'review', 'cancel', 'unsupported', 'invalid']) {
    test(`Kafka trace propagation and nested routing: ${name}`, async () => {
        exporter.reset();
        let published: { key?: string; value: string; headers?: Record<string, unknown> } | undefined;
        const event = await publishScenario({ send: async record => {
            published = record.messages[0] as typeof published;
            return [];
        } }, name, `trace-${name}`);
        assert.ok(published);
        assert.ok(published.headers?.traceparent);
        const workflow = createOrderRoutingWorkflow(async outcome => outcome, { tracer: provider.getTracer('worker') });
        let deadLetters = 0;
        const handler = createKafkaMessageHandler(workflow, {
            input: message => ({ ...JSON.parse(String(message.value)), tenant: 'apm-demo' }),
            validate: validateOrderEvent,
            deadLetter: async () => { deadLetters++; },
        });
        const message: KafkaMessage = {
            key: Buffer.from(published.key!), value: Buffer.from(published.value),
            headers: Object.fromEntries(Object.entries(published.headers || {}).map(([key, value]) => [key, Buffer.from(String(value))])),
            timestamp: '0', attributes: 0, offset: '0',
        };
        await traceKafkaHandler(handler)({ topic: 'apm.orders', partition: 0, message, heartbeat: async () => {} } as EachMessagePayload);
        const spans = exporter.getFinishedSpans();
        assert.equal(new Set(spans.map(span => span.spanContext().traceId)).size, 1);
        assert.equal(spans[0].spanContext().traceId, event.traceId);
        const publish = spans.find(span => span.name === 'kafka:publish apm.orders')!;
        const process = spans.find(span => span.name === 'kafka:process apm.orders')!;
        assert.equal(process.parentSpanContext?.spanId, publish.spanContext().spanId);
        const root = spans.find(span => span.name === 'workflow:KafkaOrderRouting');
        assert.equal(deadLetters, ['unsupported', 'invalid'].includes(name) ? 1 : 0);
        if (name === 'invalid') {
            assert.equal(root, undefined, 'Invalid JSON must not produce a workflow span');
        } else {
            assert.ok(root);
            assert.equal(root.parentSpanContext?.spanId, process.spanContext().spanId);
            assert.equal(root.status.code, name === 'unsupported' ? 2 : 1);
            const leaves = spans.filter(span => ['reserveStock', 'chargePayment', 'wrapGift', 'shipOrder', 'queueReview', 'recordCancellation', 'rejectUnsupported'].includes(String(span.attributes['siglo.step.name'])));
            const expected = name === 'review' ? ['queueReview'] : name === 'cancel' ? ['recordCancellation'] : name === 'unsupported' ? ['rejectUnsupported'] : name === 'gift' ? ['reserveStock', 'chargePayment', 'wrapGift', 'shipOrder'] : ['reserveStock', 'chargePayment', 'shipOrder'];
            assert.deepEqual(leaves.map(span => span.attributes['siglo.step.name']), expected);
            assert.ok(leaves.every(span => span.attributes['siglo.step.attempt'] === 1));
        }
        // Quarantining a failed record completes adapter handling successfully.
        assert.equal(process.status.code, 1);
    });
}

test('OTLP batch export runs outside step egress policy without changing that policy', async () => {
    let requests = 0;
    const server = createServer(async (req, res) => {
        for await (const _chunk of req) { /* consume the exported spans */ }
        requests++;
        res.setHeader('content-type', 'application/json');
        res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const isolated = isolateTelemetryExporter(new OTLPTraceExporter({ url: `http://127.0.0.1:${address.port}/v1/traces` }));
    ensureNetworkInterceptorsInstalled();
    const span = provider.getTracer('worker').startSpan('export-regression');
    span.end();
    const finished = exporter.getFinishedSpans().find(span => span.name === 'export-regression')!;
    try {
        await networkPolicyStorage.run({ enabled: true, defaultPolicy: 'deny', allowedHosts: [], allowLocalhost: false, stepName: 'reserveStock' }, async () => {
            await new Promise<void>((resolve, reject) => isolated.export([finished], result => result.code === 0 ? resolve() : reject(result.error)));
            assert.equal(networkPolicyStorage.getStore()?.stepName, 'reserveStock');
        });
        assert.equal(requests, 1);
    } finally {
        await isolated.shutdown();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
