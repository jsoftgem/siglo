import {
    Step,
    flow,
    assertValidGraph,
    CancellationException,
    FlowTimeoutException,
    UnresolvableCompensationException,
} from '@siglo/core';

// 1. Service Interfaces for Dependency Injection
export interface DatabasePool {
    query: (sql: string, params: any[]) => Promise<any>;
}

export interface PaymentClient {
    charge: (id: string, amount: number) => Promise<{ chargeId: string }>;
    refund: (chargeId: string) => Promise<void>;
}

export interface OrderPayload {
    orderId: string;
    userId: string;
    amountCents: number;
}

// 2. Step with Injected Database Dependency
export const reserveBalance = Step.create('reserveBalance', async (ctx: OrderPayload) => {
    // Injected at runtime via options.services.db
    const db = reserveBalance.requireDependency<DatabasePool>('db');
    await db.query('UPDATE accounts SET balance = balance - $1 WHERE user_id = $2', [ctx.amountCents, ctx.userId]);

    return { balanceReserved: true };
}).compensate(async (ctx, current) => {
    // Rollback balance if subsequent payment steps fail
    const db = reserveBalance.requireDependency<DatabasePool>('db');
    await db.query('UPDATE accounts SET balance = balance + $1 WHERE user_id = $2', [ctx.amountCents, ctx.userId]);
});

// 3. Step with Injected Gateway Dependency and Exponential Backoff Retries
export const captureCharge = Step.create('captureCharge', async (ctx: OrderPayload & { balanceReserved: boolean }) => {
    const payment = captureCharge.requireDependency<PaymentClient>('payment');
    const res = await payment.charge(ctx.orderId, ctx.amountCents);
    return { chargeId: res.chargeId };
})
    .onFail({
        maxRetries: 3,
        delay: 150,
        backoff: 'exponential',
        jitter: true,
        // Transient network failure predicate (respects cooperative cancellation)
        retryIf: (err: any) => err.code === 'ECONNRESET' || err.status >= 500,
    })
    .compensate(
        async ({ chargeId }) => {
            const payment = captureCharge.requireDependency<PaymentClient>('payment');
            if (chargeId) {
                await payment.refund(chargeId);
            }
        },
        {
            maxRetries: 3, // Retry compensations to avoid DLQ escalation
            delay: 500,
        },
    );

// 4. Compose Flow & Validate AST Graph
export const checkoutFlow = flow(reserveBalance, captureCharge);

// Pre-flight assertion: Throws GraphValidationException if cycles exist
assertValidGraph(checkoutFlow.toGraph());

// 5. Execution Runner Supporting Cancellation & Deadlines
export async function runCheckoutWithCancellation(
    payload: OrderPayload,
    services: { db: DatabasePool; payment: PaymentClient },
    signal?: AbortSignal,
) {
    try {
        return await checkoutFlow.run(payload, {
            signal, // Injects cooperative cancellation
            timeout: 8000, // Flow-level SLA deadline in ms
            services, // Dependency injection container
            namespace: 'orders-tenant-eu', // Multi-tenant partitioning
            pojo: true, // Clean POJO return
        });
    } catch (err: any) {
        if (err instanceof CancellationException) {
            console.warn(`[ABORT] Checkout cancelled for order ${payload.orderId}: ${err.message}`);
            return { cancelled: true, reason: err.message };
        }

        if (err instanceof FlowTimeoutException) {
            console.error(`[TIMEOUT] Checkout SLA deadline exceeded for order ${payload.orderId}`);
            throw new Error('Order processing timed out. Please try again.');
        }

        if (err instanceof UnresolvableCompensationException) {
            console.error(`[CRITICAL] Saga compensation failed! Dead-Letter alert generated.`);
            console.error(`Original Error:`, err.originalError);
            console.error(`Compensation Failure:`, err.compensationError);
            // Alert SRE / route to dead-letter queue
            throw err;
        }

        throw err;
    }
}
