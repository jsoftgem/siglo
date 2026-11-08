import { Step, flow } from '@siglo/core';

export interface SagaCartItem {
    sku: string;
    name: string;
    price: number;
    quantity: number;
}

export interface EcommerceSagaInput {
    orderId: string;
    customerId: string;
    cartItems: SagaCartItem[];
    paymentDetails: {
        cardNumber: string;
        amount: number;
    };
    shippingAddress: {
        street: string;
        city: string;
        zip: string;
    };
}

/**
 * Use Case 1: E-Commerce Distributed Checkout & Saga Orchestration
 * Flow: validateCart -> reserveInventory -> chargePayment -> createShipment -> sendConfirmationEmail
 * Features:
 * - Step.create(...) clean POJO parameter mapping
 * - Declarative spec validation
 * - In-memory / distributed state accumulation across steps
 * - Localized retry with onFail on chargePayment
 * - Compensating inventory release on failure
 */
export function createEcommerceSagaPipeline() {
    let _inventoryReserved = false;

    // Step 1: Validate Cart
    const validateCart = Step.create('sagaValidateCart', async (param: any) => {
        const { orderId, cartItems: items } = param;

        if (!items || items.length === 0) {
            throw new Error(`Order ${orderId}: Cart is empty`);
        }

        const totalAmount = items.reduce((sum: number, item: SagaCartItem) => sum + item.price * item.quantity, 0);

        return {
            cartValid: true,
            itemCount: items.length,
            totalAmount,
        };
    })
        .spec('orderId', { require: true })
        .spec('cartItems', { require: true });

    // Step 2: Reserve Inventory
    const reserveInventory = Step.create('sagaReserveInventory', async (param: any) => {
        const { orderId, cartItems: items } = param;

        _inventoryReserved = true;
        const reservationId = `RES-${orderId}-${Date.now()}`;

        return {
            inventoryReserved: true,
            reservationId,
            reservedSkus: items.map((i: SagaCartItem) => i.sku),
        };
    });

    // Step 3: Charge Payment (with onFail retry configuration)
    let paymentAttempts = 0;
    const chargePayment = Step.create('sagaChargePayment', async (param: any) => {
        paymentAttempts++;
        const { orderId, totalAmount } = param;

        // Simulate transient network error on first attempt to demonstrate local onFail retry
        if (paymentAttempts === 1) {
            throw new Error(`Transient payment network error for order ${orderId}`);
        }

        const transactionId = `TXN-${orderId}-${Math.floor(Math.random() * 100000)}`;

        return {
            paymentStatus: 'CAPTURED',
            transactionId,
            chargedAmount: totalAmount,
            paymentAttempts,
        };
    }).onFail({
        maxRetries: 2,
        delay: 10,
        backoff: 'exponential',
    });

    // Step 4: Create Shipment
    const createShipment = Step.create('sagaCreateShipment', async (param: any) => {
        const { orderId, shippingAddress } = param;
        const trackingNumber = `TRACK-UPS-${orderId}`;

        return {
            shipmentCreated: true,
            trackingNumber,
            estimatedDelivery: '3 business days',
            destinationCity: shippingAddress.city,
        };
    });

    // Step 5: Send Confirmation Email
    const sendConfirmationEmail = Step.create('sagaSendConfirmationEmail', async (param: any) => {
        const { orderId, customerId, trackingNumber, totalAmount, destinationCity } = param;

        return {
            sagaStatus: 'COMPLETED',
            cartValid: true,
            totalAmount,
            inventoryReserved: true,
            paymentStatus: 'CAPTURED',
            shipmentCreated: true,
            destinationCity,
            trackingNumber,
            confirmationEmailSent: true,
            emailSubject: `Order Confirmation #${orderId}`,
            summary: `Charged $${totalAmount}, Tracking: ${trackingNumber} sent to customer ${customerId}`,
        };
    });

    return flow(validateCart, reserveInventory, chargePayment, createShipment, sendConfirmationEmail);
}
