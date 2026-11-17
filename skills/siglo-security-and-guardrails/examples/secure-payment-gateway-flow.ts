import { Step, flow, NetworkPolicyViolationException } from '@siglo/core';

// 1. Domain Types
export interface PaymentRequest {
    paymentId: string;
    customerEmail: string;
    amountCents: number;
    currency: string;
}

export interface PaymentGatewayResponse {
    chargeId: string;
    status: 'succeeded' | 'failed';
}

// 2. Pure Calculation & Spec Step: Strictly Denies Network Egress
export const validateAndCalculateFee = Step.create('validateFee', (ctx: PaymentRequest) => {
    const processingFeeCents = Math.round(ctx.amountCents * 0.029 + 30);
    return {
        processingFeeCents,
        netAmountCents: ctx.amountCents - processingFeeCents,
        validatedAt: new Date().toISOString(),
    };
})
    .spec('paymentId', { require: true })
    .spec('customerEmail', {
        require: true,
        validate: (email: string) => email.includes('@'),
        transform: (email: string) => email.trim().toLowerCase(),
    })
    .spec('amountCents', {
        require: true,
        validate: (amt: number) => amt > 50,
    })
    .denyNetwork(); // Disallows all outbound network calls during calculation

// 3. Payment Processing Step: Narrowed to Stripe API Only
export const chargeStripe = Step.create(
    'chargeStripe',
    async (ctx: PaymentRequest & { netAmountCents: number }): Promise<PaymentGatewayResponse> => {
        // Only api.stripe.com is permitted; any other call triggers NetworkPolicyViolationException
        const response = await fetch('https://api.stripe.com/v1/charges', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder'}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                amount: ctx.netAmountCents.toString(),
                currency: ctx.currency.toLowerCase(),
            }),
        });

        if (!response.ok) {
            throw new Error(`Stripe charge failed with status ${response.status}`);
        }

        const data: any = await response.json();
        return {
            chargeId: data.id || `ch_${ctx.paymentId}`,
            status: 'succeeded',
        };
    },
)
    .allowNetwork(['api.stripe.com', '*.stripe.network'])
    .compensate(async ({ chargeId }) => {
        // Saga rollback: refund charge if downstream receipt sending fails
        if (chargeId) {
            await fetch(`https://api.stripe.com/v1/refunds`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder'}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({ charge: chargeId }),
            });
        }
    });

// 4. Receipt Notification Step: Narrowed to SendGrid API Only
export const sendEmailReceipt = Step.create('sendReceipt', async (ctx: PaymentRequest & PaymentGatewayResponse) => {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.SENDGRID_API_KEY || 'SG_placeholder'}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            personalizations: [{ to: [{ email: ctx.customerEmail }] }],
            from: { email: 'billing@example.com' },
            subject: 'Payment Confirmation',
            content: [{ type: 'text/plain', value: `Your payment of ${ctx.amountCents} was captured.` }],
        }),
    });

    return { receiptSent: response.ok };
}).allowNetwork(['api.sendgrid.com']);

// 5. Outer Flow Perimeter: Enforces Strict Host Allowlist
export const securePaymentPipeline = flow(validateAndCalculateFee, chargeStripe, sendEmailReceipt).networkPolicy({
    allowedHosts: ['api.stripe.com', '*.stripe.network', 'api.sendgrid.com'],
    defaultPolicy: 'deny',
    allowLocalhost: false, // Forbid loopback access in production
});

// 6. Execution Runner with Policy Violation Guard
export async function executeSecurePayment(req: PaymentRequest) {
    try {
        return await securePaymentPipeline.run(req, { pojo: true });
    } catch (err: any) {
        if (err instanceof NetworkPolicyViolationException) {
            console.error(`[SECURITY ALERT] Blocked unauthorized network egress to ${err.host}:${err.port}`);
            console.error(`Step: ${err.metadata?.stepName}, Phase: ${err.phase}`);
            throw new Error(`Security policy violation: outbound access to ${err.host} is forbidden.`);
        }
        throw err;
    }
}
