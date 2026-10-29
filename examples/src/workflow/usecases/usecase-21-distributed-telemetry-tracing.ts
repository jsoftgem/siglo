import { Step, flow } from 'siglo';
import {
    instrumentWorkflow,
    SemanticAttributes,
    injectTraceContext,
    extractTraceContext,
    getTraceHeaders,
    createTelemetryStorageAdapter
} from '@siglo/opentelemetry';

export interface TelemetryOrderInput {
    orderId: string;
    customerTier: string;
    apiKeySecret: string; // sensitive field to redact
    billingAddress: string;
    itemsCount: number;
}

/**
 * In-memory Mock Tracer for production demonstration & validation.
 */
export class MockSpan {
    public attributes: Record<string, any> = {};
    public status: { code: string; message?: string } = { code: 'OK' };
    public exceptions: any[] = [];
    public ended = false;

    constructor(public name: string, attributes: Record<string, any> = {}) {
        this.attributes = { ...attributes };
    }

    setAttribute(key: string, value: any) {
        this.attributes[key] = value;
        return this;
    }

    setAttributes(attrs: Record<string, any>) {
        Object.assign(this.attributes, attrs);
        return this;
    }

    recordException(err: any) {
        this.exceptions.push(err);
    }

    setStatus(status: { code: string; message?: string }) {
        this.status = status;
    }

    spanContext() {
        return {
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            spanId: '00f067aa0ba902b7',
            traceFlags: 1
        };
    }

    end() {
        this.ended = true;
    }
}

export class MockTracer {
    public spans: MockSpan[] = [];

    startSpan(name: string, options?: { attributes?: Record<string, any> }): MockSpan {
        const span = new MockSpan(name, options?.attributes);
        this.spans.push(span);
        return span;
    }
}

/**
 * Use Case 21: Distributed Tracing & W3C Trace Context Propagation
 * Adapter demonstrated: @siglo/opentelemetry
 * Features demonstrated:
 * - instrumentWorkflow wrapping workflows with OpenTelemetry workflow & step spans
 * - Retry tracking via siglo.step.attempt attributes
 * - W3C Trace Context propagation across distributed boundaries
 * - Telemetry Storage Adapter with field allowlists and namespace privacy redaction
 */
export function createObservableOrderWorkflow() {
    let callCount = 0;

    const validateOrder = Step.create('validateOrder', async (param: any) => {
        const { orderId, itemsCount } = param;
        if (!orderId) throw new Error('Missing orderId');
        return { orderId, validated: true, itemsCount: itemsCount || 1 };
    });

    const dispatchOrder = Step.create('dispatchOrder', async (param: any) => {
        const { orderId } = param;
        callCount++;
        // Simulate transient network error on 1st attempt, succeeded on 2nd
        if (callCount === 1) {
            throw new Error('TemporaryNetworkGlitch: upstream warehouse unreachable');
        }
        return {
            orderId,
            trackingNumber: `TRK-${orderId}-EXPRESS`,
            dispatchStatus: 'DISPATCHED'
        };
    }).onFail({ maxRetries: 2, delay: 5 });

    return {
        workflow: flow(validateOrder, dispatchOrder),
        resetCalls: () => { callCount = 0; }
    };
}

/**
 * Wraps order workflow with OpenTelemetry instrumentation and telemetry storage adapter.
 */
export function setupInstrumentedWorkflow(tracer: MockTracer, options?: { allowNamespace?: boolean }) {
    const { workflow, resetCalls } = createObservableOrderWorkflow();

    const instrumented = instrumentWorkflow(workflow, {
        tracer: tracer as any,
        workflowName: 'ObservableOrderWorkflow',
        workflowVersion: '2.0.0',
        allowNamespace: options?.allowNamespace ?? false
    });

    // Sanitized Telemetry Storage Adapter with field allowlisting
    const auditEvents: Array<{ field: string; val: any }> = [];
    const telemetryStorage = createTelemetryStorageAdapter({
        tracer: tracer as any,
        allowContextFields: ['orderId', 'itemsCount', 'dispatchStatus'],
        redactHook: (field, val) => {
            auditEvents.push({ field, val });
            return val;
        }
    });

    return {
        instrumented,
        telemetryStorage,
        auditEvents,
        resetCalls,
        helpers: {
            injectTraceContext,
            extractTraceContext,
            getTraceHeaders,
            SemanticAttributes
        }
    };
}
