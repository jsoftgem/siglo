import { Step, flow } from 'fluid-func';
import { fluidFastifyHandler } from '@fluid-func/fastify';
import { fluidExpressMiddleware } from '@fluid-func/express';
import { fluidMiddleware } from '@fluid-func/hono';

export interface HttpCheckoutRequest {
    orderId: string;
    items: Array<{ sku: string; price: number; quantity: number }>;
    currency: string;
    customerEmail: string;
}

export interface HttpCheckoutResponse {
    orderId: string;
    totalAmount: number;
    status: 'PAID' | 'REJECTED';
    confirmationCode: string;
}

/**
 * Use Case 18: HTTP Checkout & Order Processing Microservice
 * Frameworks demonstrated: Fastify, Express, and Hono adapters
 * Features demonstrated:
 * - Workflow wrapped seamlessly as HTTP endpoints via fluidFastifyHandler, fluidExpressMiddleware, fluidMiddleware
 * - Automated extraction of `x-namespace` and `x-stack-id` headers
 * - Typed request input extraction and response output mapping
 * - Centralized HTTP status code error handling
 */
export function createHttpCheckoutWorkflow() {
    const validateRequest = Step.create('validateRequest', async (param: any) => {
        const { orderId, items, currency } = param;
        if (!orderId || !items || !Array.isArray(items) || items.length === 0) {
            throw new Error('InvalidOrderPayload: orderId and non-empty items array are required');
        }
        const totalAmount = items.reduce((sum: number, it: any) => sum + (it.price * it.quantity), 0);
        return { orderId, totalAmount, currency: currency || 'USD', validated: true };
    }).modern();

    const authorizePayment = Step.create('authorizePayment', async (param: any) => {
        const { orderId, totalAmount, currency } = param;
        if (totalAmount > 10000) {
            throw new Error('PaymentLimitExceeded: single order cannot exceed 10000');
        }
        const confirmationCode = `CONF-${orderId.slice(-6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
        return {
            status: 'PAID',
            confirmationCode,
            paidAmount: totalAmount,
            settledCurrency: currency
        };
    }).modern();

    return flow(validateRequest, authorizePayment);
}

/**
 * Creates Fastify route handler for checkout workflow.
 */
export function createFastifyCheckoutHandler(workflow = createHttpCheckoutWorkflow()) {
    return fluidFastifyHandler(workflow, {
        input: (req: any) => req.body,
        output: (result: any) => ({
            orderId: typeof result.orderId === 'function' ? result.orderId() : result.orderId,
            totalAmount: typeof result.totalAmount === 'function' ? result.totalAmount() : result.totalAmount,
            status: typeof result.status === 'function' ? result.status() : result.status,
            confirmationCode: typeof result.confirmationCode === 'function' ? result.confirmationCode() : result.confirmationCode
        }),
        onError: (err: any) => {
            const isValidation = err.message.includes('InvalidOrderPayload');
            return {
                status: isValidation ? 400 : 500,
                body: { error: err.message, code: isValidation ? 'BAD_REQUEST' : 'INTERNAL_ERROR' }
            };
        }
    });
}

/**
 * Creates Express route handler for checkout workflow.
 */
export function createExpressCheckoutHandler(workflow = createHttpCheckoutWorkflow()) {
    return fluidExpressMiddleware(workflow, {
        input: (req: any) => req.body,
        output: (result: any) => ({
            orderId: typeof result.orderId === 'function' ? result.orderId() : result.orderId,
            totalAmount: typeof result.totalAmount === 'function' ? result.totalAmount() : result.totalAmount,
            status: typeof result.status === 'function' ? result.status() : result.status,
            confirmationCode: typeof result.confirmationCode === 'function' ? result.confirmationCode() : result.confirmationCode
        }),
        onError: (err: any, _req: any, res: any) => {
            const isValidation = err.message.includes('InvalidOrderPayload');
            const status = isValidation ? 400 : 500;
            return res.status(status).json({
                error: err.message,
                code: isValidation ? 'BAD_REQUEST' : 'INTERNAL_ERROR'
            });
        }
    });
}

/**
 * Creates Hono route handler for checkout workflow.
 */
export function createHonoCheckoutHandler(workflow = createHttpCheckoutWorkflow()) {
    return fluidMiddleware(workflow, {
        input: async (c: any) => (typeof c.req.json === 'function' ? await c.req.json() : c.req.body),
        output: (result: any) => ({
            orderId: typeof result.orderId === 'function' ? result.orderId() : result.orderId,
            totalAmount: typeof result.totalAmount === 'function' ? result.totalAmount() : result.totalAmount,
            status: typeof result.status === 'function' ? result.status() : result.status,
            confirmationCode: typeof result.confirmationCode === 'function' ? result.confirmationCode() : result.confirmationCode
        }),
        onError: (err: any) => {
            const isValidation = err.message.includes('InvalidOrderPayload');
            return {
                status: isValidation ? 400 : 500,
                body: { error: err.message, code: isValidation ? 'BAD_REQUEST' : 'INTERNAL_ERROR' }
            };
        }
    });
}
