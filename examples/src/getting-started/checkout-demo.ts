import { createCheckout, TemporaryPaymentError } from './checkout';
import type { CheckoutServices, Order } from './checkout';

export function createDemoServices(failShipping = false) {
    const events: string[] = [];
    let paymentAttempts = 0;

    const services: CheckoutServices = {
        async reserve(order) {
            events.push('reserve stock');
            return `reservation-${order.orderId}`;
        },
        async release() { events.push('release stock'); },
        async charge(order) {
            paymentAttempts++;
            events.push(`charge attempt ${paymentAttempts}`);
            if (paymentAttempts === 1) {
                // Simulate an unavailable gateway BEFORE it accepts a charge.
                throw new TemporaryPaymentError('Payment gateway unavailable');
            }
            return `payment-${order.orderId}`;
        },
        async refund() { events.push('refund payment'); },
        async ship(order) {
            events.push('arrange shipping');
            if (failShipping) throw new Error('No courier available');
            return `tracking-${order.orderId}`;
        }
    };

    return { services, events };
}

export const sampleOrder: Order = {
    orderId: 'order-1001', sku: 'coffee-kit', quantity: 1, amountCents: 4500
};

async function main() {
    for (const failShipping of [false, true]) {
        const { services, events } = createDemoServices(failShipping);
        const checkout = createCheckout(services);
        console.log(failShipping ? 'Shipping failure:' : 'Successful checkout:');
        try {
            const result = await checkout.run(sampleOrder, { pojo: true });
            console.log(result.trackingId);
        } catch (error) {
            console.log(error instanceof Error ? error.message : String(error));
        }
        console.log(events.join(' -> '));
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
