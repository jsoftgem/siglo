import { after, describe, it } from 'node:test';
import assert from 'node:assert';
import { runStepLatenciesScenario } from './scenarios/1-step-latencies';
import { runRetriesScenario } from './scenarios/2-retries';
import { runSagaRollbackScenario } from './scenarios/3-saga-rollback';
import { runDistributedCallsScenario } from './scenarios/4-distributed-calls';
import { createMonitorServer } from '@siglo/monitor';
import { shutdownTelemetry } from './tracer';

process.env.NODE_ENV = 'test';
after(shutdownTelemetry);

describe('Zero-Code APM Monitoring & OpenTelemetry Integration', () => {
    it('Scenario 1: tracks step latencies and parallel branch spans', async () => {
        const { result, spans } = await runStepLatenciesScenario({ silent: true });

        assert.ok(result.invoiceId.startsWith('INV-ORD-1001'));
        assert.strictEqual(result.total, 108.0);

        const spanNames = spans.map(s => s.name);
        assert.ok(spanNames.includes('workflow:OrderFulfillmentPipeline'));
        assert.ok(spanNames.includes('step:validateOrder'));
        assert.ok(spanNames.includes('step:enrichCustomer'));
        assert.ok(spanNames.includes('step:checkInventory'));
        assert.ok(spanNames.includes('step:performRiskAssessment'));
        assert.ok(spanNames.includes('step:fetchPricingRules'));
        assert.ok(spanNames.includes('step:generateInvoice'));

        // All spans in successful flow should have OK status
        for (const s of spans) {
            assert.strictEqual(s.status.code, 1, `Span ${s.name} should be OK`);
        }
    });

    it('Scenario 2: records retry attempts and transient failure exceptions', async () => {
        const { result, spans, attempts } = await runRetriesScenario({ silent: true });

        assert.strictEqual(attempts, 3);
        assert.strictEqual(result.status, 'CAPTURED');

        const spanNames = spans.map(s => s.name);
        assert.ok(spanNames.includes('step:chargeCreditCard'));
        assert.ok(spanNames.includes('step:chargeCreditCard (retry #2)'));
        assert.ok(spanNames.includes('step:chargeCreditCard (retry #3)'));

        // Failed attempts should have ERROR status and exception events
        const firstAttempt = spans.find(s => s.name === 'step:chargeCreditCard');
        assert.ok(firstAttempt);
        assert.strictEqual(firstAttempt.status.code, 2, 'First attempt should be ERROR');
        assert.ok(firstAttempt.events.some(e => e.name === 'exception'));

        // Final attempt should be OK
        const thirdAttempt = spans.find(s => s.name === 'step:chargeCreditCard (retry #3)');
        assert.ok(thirdAttempt);
        assert.strictEqual(thirdAttempt.status.code, 1, 'Third attempt should be OK');
    });

    it('Scenario 3: traces saga failures and LIFO compensation rollbacks', async () => {
        const { caughtError, auditTrail, spans } = await runSagaRollbackScenario({ silent: true });

        assert.ok(caughtError);
        assert.match(caughtError.message, /AirlineInventoryExhausted/);

        // LIFO order: reserve hotel -> charge payment -> refund payment -> cancel hotel
        assert.deepStrictEqual(auditTrail, [
            'HOTEL_RESERVED',
            'PAYMENT_CHARGED',
            'PAYMENT_REFUNDED',
            'HOTEL_CANCELLED'
        ]);

        const rootSpan = spans.find(s => s.name === 'workflow:HolidayBookingSaga');
        assert.ok(rootSpan);
        assert.strictEqual(rootSpan.status.code, 2, 'Workflow span should be ERROR');

        const spanNames = spans.map(s => s.name);
        assert.ok(spanNames.includes('compensation:refundPayment'));
        assert.ok(spanNames.includes('compensation:releaseHotelRoom'));
    });

    it('Scenario 4: propagates W3C trace context across distributed parent-child services', async () => {
        const { upstreamResult, downstreamResult, spans, outgoingHeaders } =
            await runDistributedCallsScenario({ silent: true });

        assert.ok(outgoingHeaders.traceparent);
        assert.ok(downstreamResult.trackingCode);

        // All spans across both services MUST share the same traceId
        const traceIds = new Set(spans.map(s => s.spanContext().traceId));
        assert.strictEqual(traceIds.size, 1, 'All spans must share identical traceId');

        const rootTraceId = [...traceIds][0];
        assert.ok(outgoingHeaders.traceparent.includes(rootTraceId));

        // Downstream workflow span must have parentSpanContext linked to upstream execution
        const downstreamWorkflowSpan = spans.find(s => s.name === 'workflow:WarehouseFulfillmentFlow');
        assert.ok(downstreamWorkflowSpan);
        assert.ok(downstreamWorkflowSpan.parentSpanContext, 'Downstream span should have parentSpanContext');
    });

    it('exposes workflow completion and retry metrics from the scenario event emitter', async () => {
        const monitor = await createMonitorServer({ port: 0, host: '127.0.0.1', allowRemoteResume: false });
        try {
            await runRetriesScenario({ silent: true, emitter: monitor.emitter });
            const response = await fetch(`http://127.0.0.1:${monitor.port}/metrics`);
            assert.strictEqual(response.status, 200);
            const metrics = await response.text();
            assert.match(metrics, /siglo_flows_total\{status="completed"\} 1/);
            assert.match(metrics, /siglo_step_retries_total 2/);
            assert.match(metrics, /siglo_active_flows 0/);
        } finally {
            await monitor.close();
        }
    });
});
