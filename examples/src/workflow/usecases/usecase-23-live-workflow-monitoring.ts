import { Step, flow, waitForEvent, WorkflowEventEmitter } from '@siglo/core';
import { createMonitorServer, MonitorServerInstance } from '@siglo/monitor';

export interface MonitoredOrderInput {
    orderId: string;
    customerId: string;
    amount: number;
    authToken: string; // sensitive key to redact
    isVip?: boolean;
}

/**
 * Creates an e-commerce order processing workflow configured with
 * live monitoring, automated retries, conditional skips, and durable waits.
 */
export function createMonitoredOrderWorkflow(emitter?: WorkflowEventEmitter) {
    let inventoryAttempts = 0;

    const validateOrder = Step.create('validateOrder', async (ctx: MonitoredOrderInput) => {
        return {
            validated: true,
            orderId: ctx.orderId,
            amount: ctx.amount,
            authToken: ctx.authToken,
        };
    });

    const checkInventory = Step.create('checkInventory', async () => {
        inventoryAttempts++;
        if (inventoryAttempts < 2) {
            throw new Error('Inventory database lock timeout; retry needed');
        }
        return { inStock: true, warehouse: 'WH-East' };
    }).onFail({ maxRetries: 2, delay: 10 });

    const applyVipDiscount = Step.create('applyVipDiscount', async (ctx: any) => {
        return {
            discountApplied: true,
            discountAmount: ctx.amount * 0.15,
            finalAmount: ctx.amount * 0.85,
        };
    }).onBefore((ctx: any) => ctx.isVip === true);

    const chargeCustomer = Step.create('chargeCustomer', async (ctx: any) => {
        return {
            charged: true,
            transactionId: `tx_${Date.now()}`,
            amountCharged: ctx.finalAmount || ctx.amount,
        };
    });

    const awaitFulfillmentApproval = waitForEvent('fulfillment.approved', {
        correlationKey: (ctx: any) => ctx.orderId,
        timeout: '1h',
    });

    const completeOrder = Step.create('completeOrder', async (ctx: any) => {
        return {
            status: 'COMPLETED',
            orderId: ctx.orderId,
            shippedAt: new Date().toISOString(),
        };
    });

    const pipeline = flow(
        validateOrder,
        checkInventory,
        applyVipDiscount,
        chargeCustomer,
        awaitFulfillmentApproval,
        completeOrder,
    );

    if (emitter) {
        pipeline.monitor(emitter);
    }

    return {
        pipeline,
        getAttempts: () => inventoryAttempts,
    };
}

/**
 * Sets up and runs the live monitoring demo server and execution suite.
 */
export async function runLiveMonitoringSample(): Promise<{
    monitor: MonitorServerInstance;
    runResult: any;
    metricsText: string;
}> {
    const monitor = await createMonitorServer({
        port: 0, // dynamic port for testing & zero conflict
        host: '0.0.0.0',
        redaction: {
            redactKeys: ['authToken', 'creditCard'],
        },
    });

    const { pipeline } = createMonitoredOrderWorkflow(monitor.emitter);
    monitor.workflows.set('default', pipeline);

    let suspendedStackId = '';
    let runResult: any;

    try {
        runResult = await pipeline.run(
            {
                orderId: 'ORD-LIVE-777',
                customerId: 'cust_882',
                amount: 250,
                authToken: 'super-secret-jwt-token',
                isVip: false,
            },
            {
                durable: true,
                monitor: ev => {
                    if (ev.type === 'flow:start') {
                        suspendedStackId = ev.stackId;
                    }
                },
            },
        );
    } catch {
        // Expected suspension at awaitFulfillmentApproval
    }

    if (suspendedStackId) {
        monitor.workflows.set(suspendedStackId, pipeline);
    }

    const metricsText = monitor.metrics.getMetricsAsText();

    return {
        monitor,
        runResult,
        metricsText,
    };
}
