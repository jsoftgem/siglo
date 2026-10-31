import { Step, flow, waitForEvent, resumeWorkflow } from 'siglo';
import { createMonitorServer } from '@siglo/monitor';

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

const fetchCustomer = Step.create('fetchCustomer', async (ctx: OrderPayload) => {
    return {
        customerTier: ctx.isVip ? 'VIP_PLATINUM' : 'STANDARD',
        verified: true,
        region: 'US-EAST'
    };
});

const assessRiskScore = Step.create('assessRiskScore', async (ctx: any) => {
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

const applyVipDiscount = Step.create('applyVipDiscount', async (ctx: any) => {
    const discount = ctx.amount * 0.20;
    return {
        discountApplied: true,
        discountAmount: discount,
        finalAmount: ctx.amount - discount
    };
}).onBefore((ctx: any) => ctx.isVip === true);

const chargeCreditCard = Step.create('chargeCreditCard', async (ctx: any) => {
    return {
        charged: true,
        paymentReference: `PAY-${Date.now()}`,
        netCharged: ctx.finalAmount || ctx.amount,
        // Sensitive data will be automatically masked in monitoring streams
        token: ctx.authToken,
        cardNumber: ctx.cardNumber
    };
});

const awaitHumanApproval = waitForEvent('order.approved', {
    correlationKey: (ctx: any) => ctx.orderId,
    timeout: '24h'
});

const finalizeFulfillment = Step.create('finalizeFulfillment', async (ctx: any) => {
    return {
        fulfillmentStatus: 'DISPATCHED',
        trackingNumber: `TRK-USPS-${Math.floor(Math.random() * 900000 + 100000)}`,
        shippedAt: new Date().toISOString()
    };
});

// 2. Compose Flow
const orderFulfillmentFlow = flow(
    fetchCustomer,
    assessRiskScore,
    applyVipDiscount,
    chargeCreditCard,
    awaitHumanApproval,
    finalizeFulfillment
);

async function main() {
    console.log('========================================================================');
    console.log('         Siglo Live Monitoring & DevTools Sample Project');
    console.log('========================================================================\n');

    const port = Number(process.env.PORT) || 4000;
    const monitor = await createMonitorServer({
        port,
        host: '0.0.0.0',
        flow: orderFulfillmentFlow,
        redaction: {
            redactKeys: ['authToken', 'cardNumber', 'secret']
        }
    });

    console.log(`🚀 Live Monitor Server running at http://localhost:${monitor.port}`);
    console.log(`   - Web DevTools Dashboard: http://localhost:${monitor.port}/`);
    console.log(`   - Live SSE Stream:        http://localhost:${monitor.port}/events`);
    console.log(`   - WebSocket Protocol:     ws://localhost:${monitor.port}/ws`);
    console.log(`   - Prometheus Metrics:     http://localhost:${monitor.port}/metrics`);
    console.log('\n------------------------------------------------------------------------\n');

    // Attach monitor to flow
    orderFulfillmentFlow.monitor(monitor.emitter);

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
    }, 3000);
}

if (require.main === module) {
    main().catch(console.error);
}
