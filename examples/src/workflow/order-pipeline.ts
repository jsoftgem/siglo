import { Step, flow } from 'siglo';

export interface OrderItem {
    id: string;
    name: string;
    price: number;
    quantity: number;
}

export interface OrderInput {
    orderId: string;
    customer: {
        name: string;
        email: string;
    };
    items: OrderItem[];
    couponCode?: string;
}

export function createOrderPipeline() {
    // 1. Step 1: Validate Order & Compute Subtotal
    const validateOrder = Step.create('validateOrder', async (param: any) => {
        const items: OrderItem[] = param.items;
        const customer = param.customer;

        if (!items || items.length === 0) {
            throw new Error('Order must contain at least one item');
        }
        if (!customer || !customer.email) {
            throw new Error('Valid customer email is required');
        }

        const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

        return {
            isValid: true,
            subtotal
        };
    })
      .spec('orderId', { require: true })
      .spec('items', { require: true })
      .spec('customer', { require: true });

    // 2. Step 2: Calculate Pricing, Discounts, and Taxes
    const calculatePricing = Step.create('calculatePricing', async (param: any) => {
        const subtotal = param.subtotal;
        const couponCode = param.couponCode ?? null;

        let discount = 0;
        if (couponCode === 'SAVE10') {
            discount = subtotal * 0.10;
        } else if (subtotal >= 100) {
            discount = 15; // $15 off orders over $100
        }

        const discountedSubtotal = Math.max(0, subtotal - discount);
        const tax = +(discountedSubtotal * 0.08).toFixed(2);
        const finalTotal = +(discountedSubtotal + tax).toFixed(2);

        return {
            discount,
            tax,
            finalTotal
        };
    });

    // 3. Step 3: Generate Invoice Receipt
    const generateInvoice = Step.create('generateInvoice', async (param: any) => {
        const orderId = param.orderId;
        const finalTotal = param.finalTotal;
        const customer = param.customer;

        return {
            invoiceId: `INV-${orderId}`,
            invoiceStatus: 'PAID',
            billedTo: customer.email,
            subtotal: param.subtotal,
            discount: param.discount,
            tax: param.tax,
            amountCharged: finalTotal,
            issuedAt: new Date().toISOString()
        };
    });

    return flow(
        validateOrder,
        calculatePricing,
        generateInvoice
    );
}
