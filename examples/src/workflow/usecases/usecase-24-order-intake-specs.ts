import { Step, flow } from '@siglo/core';

export interface OrderIntakeInput {
    orderId: string;
    email: string;
    countryCode: string;
    quantity: number;
    unitPrice: number;
    shippingAddress: { city: string; postalCode: string };
    currency?: string;
    shippingMethod?: string;
    purchaseOrder?: string;
}

/**
 * Use Case 24: Order Intake Contracts
 * Covers every SpecData option, including the long and short aliases:
 * default/defaultValue, require/requireMessage, validate/validator,
 * transform/transformer, translate/translator, and schema.
 *
 * Specs run concurrently: transformations, defaults, and translations must not
 * depend on sibling specs completing. Use a later step for dependent checks.
 * Translators write derived fields through context.set(); their return is ignored.
 *
 * Try: createOrderIntakeSpecsPipeline().run({
 *   orderId: 'ORD-24', email: ' Buyer@Example.com ', countryCode: 'ph',
 *   quantity: 2, unitPrice: 125,
 *   shippingAddress: { city: 'Manila', postalCode: '1000' }
 * });
 */
export function createOrderIntakeSpecsPipeline(requirePurchaseOrder = false) {
    const normalize = Step.create('orderIntakeNormalize', async (param: any) => ({
        normalizedOrder: {
            orderId: param.orderId,
            email: param.email,
            countryCode: param.countryCode,
            quantity: param.quantity,
            unitPrice: param.unitPrice,
            currency: param.currency,
            shippingMethod: param.shippingMethod,
            shippingAddress: param.shippingAddress,
            customerDomain: param.customerDomain,
            shippingRegion: param.shippingRegion,
            purchaseOrder: param.purchaseOrder,
        },
    }))
        .spec('orderId', { require: true, requireMessage: 'An order ID is required.' })
        .spec('purchaseOrder', {
            require: () => requirePurchaseOrder,
            requireMessage: 'Business orders require a purchase order.',
        })
        .spec('currency', { default: 'PHP' })
        .spec('shippingMethod', { defaultValue: 'STANDARD' })
        .spec('quantity', {
            validate: async (value: unknown) => {
                if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
                    throw new Error('Quantity must be a positive integer.');
                }
            },
        })
        .spec('unitPrice', {
            validator: async (value: unknown) => {
                if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
                    throw new Error('Unit price must be a positive finite number.');
                }
            },
        })
        .spec('email', {
            require: true,
            transform: async (value: string) => value.trim().toLowerCase(),
        })
        .spec('countryCode', {
            require: true,
            transformer: async (value: string) => value.trim().toUpperCase(),
        })
        .spec('email', {
            translate: async (value: string, context) => {
                context.set('customerDomain', value.trim().toLowerCase().split('@')[1]);
            },
        })
        .spec('countryCode', {
            translator: async (value: string, context) => {
                context.set('shippingRegion', value.trim().toUpperCase() === 'PH' ? 'DOMESTIC' : 'INTERNATIONAL');
            },
        })
        // A field-level schema predicate checks structured data without a dependency.
        .spec('shippingAddress', {
            schema: (value: OrderIntakeInput['shippingAddress'] | undefined) =>
                typeof value?.city === 'string' &&
                value.city.trim().length > 0 &&
                typeof value?.postalCode === 'string' &&
                value.postalCode.trim().length > 0,
        });

    // The whole-input overload receives the accumulated context. This parser
    // runs after normalization, so it can safely inspect the normalized email.
    const accept = Step.create('orderIntakeAccept', async (param: any) => ({
        orderIntakeStatus: 'ACCEPTED',
        order: param.normalizedOrder,
        totalAmount: param.normalizedOrder.quantity * param.normalizedOrder.unitPrice,
    })).spec({
        parse: (data: any) => {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.normalizedOrder.email)) {
                throw new Error('A valid customer email is required.');
            }
            return data;
        },
    });

    return flow(normalize, accept);
}
