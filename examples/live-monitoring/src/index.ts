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
        const id = typeof ctx.orderId === 'function' ? ctx.orderId() : ctx.orderId;
        console.log(`Awaiting human approval for order: ${id}`);
        return id || (typeof ctx.$stackId === 'function' ? ctx.$stackId() : (ctx.$stackId || ctx.stackId));
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
     * - Durable execution control: pass X-Durable: true (or query/body durable: true)
     *   to pause at awaitHumanApproval and allow interactive resumption via the DevTools UI
     *   or the approval API. Without durability, runs through synchronously to completion.
     * - Typed request body parsing and result extraction
     * - Automatic stack ID injection (X-Workflow-Stack-Id header)
     * - Error-to-HTTP status code mapping
     */
    const executeWorkflowHandler = sigloExpressMiddleware(workflow, {
        allowHeaderNamespace: true,
        correlationIdHeader: 'x-correlation-id',
        durable: (req: Request) => {
            const h = req.headers?.['x-durable'];
            const q = req.query?.durable;
            const b = req.body?.durable;
            return h === 'true' || q === 'true' || b === true;
        },
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
                    message: `Workflow suspended waiting for '${result.eventName}'. Approve in DevTools UI or via POST /api/orders/${result.correlationKey}/approve`
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
                error: err.message || 'Workflow execution failed'
            });
        }
    });

    // Mount workflow execution routes
    app.post('/api/orders', executeWorkflowHandler);
    app.post('/api/orders/execute', executeWorkflowHandler);

    // Resumption endpoint to approve suspended orders via API
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
                fulfillmentStatus: finalResult.fulfillmentStatus || 'DISPATCHED',
                trackingNumber: finalResult.trackingNumber
            });
        } catch (err: any) {
            return res.status(400).json({
                error: err.message,
                orderId,
                hint: 'The workflow is either already completed or not suspended waiting for approval.'
            });
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
            // Ignore if port in use
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

    return { monitor, apiApp, apiServer };
}

if (require.main === module) {
    main().catch(console.error);
}
