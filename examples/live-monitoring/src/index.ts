import express, { Express, Request, Response } from 'express';
import { Step, flow, waitForEvent, resumeWorkflow } from 'siglo';
import { createMonitorServer } from '@siglo/monitor';
import { sigloExpressMiddleware } from '@siglo/express';

export interface OrderPayload {
    orderId: string;
    customerId: string;
    amount: number;
    authToken: string;
    cardNumber: string;
    isVip?: boolean;
}

// 1. Define Step Pipeline
let attemptCounter = 0;

export const fetchCustomer = Step.create('fetchCustomer', async (ctx: OrderPayload) => {
    return {
        customerTier: ctx.isVip ? 'VIP_PLATINUM' : 'STANDARD',
        verified: true,
        region: 'US-EAST'
    };
});

export const assessRiskScore = Step.create('assessRiskScore', async (ctx: any) => {
    attemptCounter++;
    // Simulate a transient network timeout on attempt 1
    if (attemptCounter % 3 === 1) {
        throw new Error('Risk assessment service unavailable (HTTP 503)');
    }
    return {
        riskScore: ctx.amount > 500 ? 42 : 12,
        requiresManualReview: ctx.amount > 500
    };
}).onFail({ maxRetries: 2, delay: 50 });

export const applyVipDiscount = Step.create('applyVipDiscount', async (ctx: any) => {
    const discount = ctx.amount * 0.20;
    return {
        discountApplied: true,
        discountAmount: discount,
        finalAmount: ctx.amount - discount
    };
}).onBefore((ctx: any) => ctx.isVip === true);

export const chargeCreditCard = Step.create('chargeCreditCard', async (ctx: any) => {
    return {
        charged: true,
        paymentReference: `PAY-${Date.now()}`,
        netCharged: ctx.finalAmount || ctx.amount,
        // Sensitive data will be automatically masked in monitoring streams
        token: ctx.authToken,
        cardNumber: ctx.cardNumber
    };
});

export const awaitHumanApproval = waitForEvent('order.approved', {
    correlationKey: (ctx: any) => {
        return ctx.$stackId
    },
    timeout: '24h'
});

export const finalizeFulfillment = Step.create('finalizeFulfillment', async (ctx: any) => {
    return {
        fulfillmentStatus: 'DISPATCHED',
        trackingNumber: `TRK-USPS-${Math.floor(Math.random() * 900000 + 100000)}`,
        shippedAt: new Date().toISOString()
    };
});

// 2. Compose Flow
export const orderFulfillmentFlow = flow(
    fetchCustomer,
    assessRiskScore,
    applyVipDiscount,
    chargeCreditCard,
    awaitHumanApproval,
    finalizeFulfillment
);

/**
 * Creates the Express API application using @siglo/express to expose
 * workflow execution via standard HTTP REST endpoints.
 */
export function createOrderApiApp(workflow = orderFulfillmentFlow): Express {
    const app = express();
    app.use(express.json());

    // Health / service status endpoint
    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', service: 'order-fulfillment-service' });
    });

    /**
     * Expose workflow execution via @siglo/express middleware handler.
     * Integrates:
     * - Correlation ID propagation (X-Correlation-Id header)
     * - Multi-tenant namespace scope (x-namespace header)
     * - Durable execution control (x-durable header or query param)
     * - Typed request body parsing and result extraction
     * - Automatic stack ID injection (X-Workflow-Stack-Id header)
     * - Error-to-HTTP status code mapping
     */
    const executeWorkflowHandler = sigloExpressMiddleware(workflow, {
        allowHeaderNamespace: true,
        correlationIdHeader: 'x-correlation-id',
        input: (req: Request) => ({
            orderId: req.body?.orderId || `ORD-${Date.now()}`,
            customerId: req.body?.customerId || 'cust_guest',
            amount: Number(req.body?.amount) || 100,
            authToken: req.body?.authToken || 'jwt-auth-default-token',
            cardNumber: req.body?.cardNumber || '4111-2222-3333-4444',
            isVip: Boolean(req.body?.isVip)
        }),
        output: (result: any, res: Response) => {
            // Handle durable workflow suspension (waiting for human approval)
            if (result.status === 'waiting') {
                return res.status(202).json({
                    status: 'SUSPENDED',
                    stackId: result.stackId,
                    correlationKey: result.correlationKey,
                    waitingForEvent: result.eventName,
                    message: `Workflow suspended waiting for '${result.eventName}'. Approve via POST /api/orders/${result.correlationKey}/approve`
                });
            }

            return res.status(201).json({
                success: true,
                orderId: result.orderId,
                fulfillmentStatus: result.fulfillmentStatus || 'COMPLETED',
                trackingNumber: result.trackingNumber,
                customerTier: result.customerTier,
                riskScore: result.riskScore,
                netCharged: result.netCharged || result.finalAmount || result.amount,
                discountApplied: result.discountApplied ?? false,
                discountAmount: result.discountAmount || 0,
                region: result.region,
                paymentReference: result.paymentReference
            });
        },
        onError: (err: any, _req: Request, res: Response) => {
            console.error('[Workflow API Error]:', err.message);
            const status = err.status || 500;
            return res.status(status).json({
                error: err.message || 'Workflow execution error'
            });
        }
    });

    // Mount workflow execution routes
    app.post('/api/orders', executeWorkflowHandler);
    app.post('/api/orders/execute', executeWorkflowHandler);

    // Resumption endpoint to approve suspended orders
    app.post('/api/orders/:orderId/approve', async (req: Request, res: Response) => {
        const { orderId } = req.params;
        const stackId = req.body?.stackId || req.query?.stackId as string;
        try {
            const finalResult = await resumeWorkflow(workflow, stackId || orderId, {
                approvedBy: req.body?.approvedBy || 'compliance-officer@corp.internal',
                decisionNotes: req.body?.decisionNotes || 'Approved via Express API'
            });
            return res.json({
                success: true,
                orderId,
                fulfillmentStatus: finalResult.fulfillmentStatus,
                trackingNumber: finalResult.trackingNumber
            });
        } catch (err: any) {
            return res.status(400).json({ error: err.message });
        }
    });

    return app;
}

export async function main() {
    console.log('========================================================================');
    console.log('      Siglo Live Monitoring & Express API Sample Project');
    console.log('========================================================================\n');

    const port = Number(process.env.PORT) || 4000;
    const apiPort = Number(process.env.API_PORT) || 3000;

    // 1. Initialize Express App with @siglo/express routes
    const apiApp = createOrderApiApp(orderFulfillmentFlow);

    // 2. Start Live Monitor Server
    const monitor = await createMonitorServer({
        port,
        host: '0.0.0.0',
        flow: orderFulfillmentFlow,
        redaction: {
            redactKeys: ['authToken', 'cardNumber', 'secret']
        }
    });

    // Attach monitor to flow so API executions stream live into DevTools
    orderFulfillmentFlow.monitor(monitor.emitter);

    // Integrate Express app directly onto the monitor HTTP server on port 4000
    const originalListeners = monitor.server.listeners('request').slice();
    monitor.server.removeAllListeners('request');
    monitor.server.on('request', (req, res) => {
        if (req.url?.startsWith('/api/orders') || req.url?.startsWith('/health')) {
            apiApp(req, res);
        } else {
            for (const listener of originalListeners) {
                listener.call(monitor.server, req, res);
            }
        }
    });

    // Also optionally listen on dedicated API port if configured or separate
    let apiServer: any;
    if (apiPort !== port) {
        try {
            apiServer = apiApp.listen(apiPort, '0.0.0.0', () => {
                console.log(`📡 Express API Server running at http://localhost:${apiPort}`);
                console.log(`   - Order Execution API:    POST http://localhost:${apiPort}/api/orders`);
                console.log(`   - Order Approval API:     POST http://localhost:${apiPort}/api/orders/:orderId/approve`);
            });
        } catch {
            // Ignore if port 3000 in use
        }
    }

    console.log(`🚀 Live Monitor Server running at http://localhost:${monitor.port}`);
    console.log(`   - Web DevTools Dashboard: http://localhost:${monitor.port}/`);
    console.log(`   - Live SSE Stream:        http://localhost:${monitor.port}/events`);
    console.log(`   - WebSocket Protocol:     ws://localhost:${monitor.port}/ws`);
    console.log(`   - Prometheus Metrics:     http://localhost:${monitor.port}/metrics`);
    console.log(`   - Workflow Execution API: POST http://localhost:${monitor.port}/api/orders`);
    console.log(`   - Workflow Approval API:  POST http://localhost:${monitor.port}/api/orders/:orderId/approve`);
    console.log('\n------------------------------------------------------------------------\n');

    // 3. Trigger Sample Workflows
    console.log('[Demo] Executing Workflow 1: Standard Order (ORD-101)...');
    let stackId1 = '';
    try {
        await orderFulfillmentFlow.run({
            orderId: 'ORD-101',
            customerId: 'cust_alice',
            amount: 150,
            authToken: 'jwt-auth-alice-999',
            cardNumber: '4111-2222-3333-4444',
            isVip: false
        }, {
            durable: true,
            namespace: 'ecommerce-retail',
            monitor: (ev) => {
                if (ev.type === 'flow:start') stackId1 = ev.stackId;
            }
        });
    } catch {
        console.log(`  ⏳ Workflow 1 suspended at 'awaitHumanApproval' (Stack ID: ${stackId1})`);
    }

    console.log('[Demo] Executing Workflow 2: VIP Order with Discount (ORD-202)...');
    let stackId2 = '';
    try {
        await orderFulfillmentFlow.run({
            orderId: 'ORD-202',
            customerId: 'cust_bob',
            amount: 750,
            authToken: 'jwt-auth-bob-secret',
            cardNumber: '5500-0000-0000-0004',
            isVip: true
        }, {
            durable: true,
            namespace: 'ecommerce-vip',
            monitor: (ev) => {
                if (ev.type === 'flow:start') stackId2 = ev.stackId;
            }
        });
    } catch {
        console.log(`  ⏳ Workflow 2 suspended at 'awaitHumanApproval' (Stack ID: ${stackId2})`);
    }

    // 4. Simulate Automatic Resumption of Workflow 1 after 3 seconds
    console.log('\n[Demo] Waiting 3 seconds before automatically resuming Workflow 1...');
    setTimeout(async () => {
        if (stackId1) {
            console.log(`[Demo] Sending resumption signal 'order.approved' for ${stackId1}...`);
            try {
                const finalResult = await resumeWorkflow(orderFulfillmentFlow, stackId1, {
                    approvedBy: 'compliance-manager@corp.internal',
                    decisionNotes: 'Customer verified in good standing'
                });
                console.log(`  ✔ Workflow 1 completed! Status: ${finalResult.fulfillmentStatus}, Tracking: ${finalResult.trackingNumber}`);
            } catch (err: any) {
                console.error('Resumption error:', err.message);
            }
        }
        console.log('\n✨ Both workflows processed! Keep server running to inspect DevTools dashboard at http://localhost:' + monitor.port);
        console.log('💡 Trigger new workflow executions via Express API:');
        console.log(`   curl -X POST http://localhost:${port}/api/orders \\`);
        console.log(`     -H "Content-Type: application/json" \\`);
        console.log(`     -H "X-Namespace: ecommerce-retail" \\`);
        console.log(`     -d '{"orderId":"ORD-303","customerId":"cust_charlie","amount":600,"authToken":"sec-123","cardNumber":"4000-1111-2222-3333","isVip":true}'\n`);
    }, 3000);

    return { monitor, apiApp, apiServer };
}

if (require.main === module) {
    main().catch(console.error);
}
