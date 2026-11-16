import express from 'express';
import { Step, flow } from '@siglo/core';
import { sigloExpressMiddleware } from '@siglo/express';
import { createMonitorServer } from '@siglo/monitor';

// 1. Define Business Workflow
export interface PaymentRequest {
    orderId: string;
    amountCents: number;
    paymentMethodToken: string;
}

const validateRequest = Step.create('validateRequest', (req: PaymentRequest) => {
    if (!req.orderId || !req.paymentMethodToken) {
        throw new Error('orderId and paymentMethodToken are required');
    }
    if (!req.amountCents || req.amountCents <= 0) {
        throw new Error('amountCents must be a positive integer');
    }
    return { validated: true };
});

const chargeStripe = Step.create('chargeStripe', async (ctx: PaymentRequest) => {
    // Simulate Stripe API call
    return {
        chargeId: `ch_${Date.now()}`,
        status: 'SUCCEEDED',
        authorizedAmountCents: ctx.amountCents,
    };
}).compensate(async ({ chargeId }) => {
    console.log(`[Compensation] Refunding Stripe charge ${chargeId}`);
});

const sendReceipt = Step.create('sendReceipt', async (ctx: PaymentRequest & { chargeId: string }) => {
    return {
        receiptUrl: `https://invoices.example.com/receipts/${ctx.orderId}`,
        sentAt: new Date().toISOString(),
    };
});

export const paymentWorkflow = flow(validateRequest, chargeStripe, sendReceipt);

// 2. Setup Express Server with Live DevTools Monitor
export async function startServer(apiPort = 3000, monitorPort = 4000) {
    // Launch live DevTools server at http://localhost:4000
    const monitor = await createMonitorServer({
        port: monitorPort,
        host: '127.0.0.1',
    });
    console.log(`Siglo DevTools Monitor running at http://127.0.0.1:${monitorPort}`);

    const app = express();
    app.use(express.json());

    // Mount workflow route via sigloExpressMiddleware
    app.post(
        '/api/payments/charge',
        sigloExpressMiddleware(paymentWorkflow.monitor(monitor.emitter), {
            input: req => req.body as PaymentRequest,
            namespace: 'payments',
            timeout: 5000,
            correlationIdHeader: 'x-request-id',
            output: (result, res) => {
                return res.status(201).json({
                    success: true,
                    chargeId: result.chargeId,
                    receiptUrl: result.receiptUrl,
                });
            },
        }),
    );

    const server = app.listen(apiPort, () => {
        console.log(`Payment API listening on http://localhost:${apiPort}`);
    });

    return { app, server, monitor };
}
