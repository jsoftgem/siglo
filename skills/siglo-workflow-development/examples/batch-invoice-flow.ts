import { Step, flow, map } from '@siglo/core';

export interface InvoiceItem {
    id: string;
    description: string;
    unitPriceCents: number;
    qty: number;
}

export interface BillingBatchInput {
    batchId: string;
    customerId: string;
    items: InvoiceItem[];
}

// Atomic step processing a single invoice line item
const processInvoiceItem = Step.create('processInvoiceItem', async (item: InvoiceItem) => {
    const subtotal = item.unitPriceCents * item.qty;
    // Simulate database write or external microservice call
    await new Promise(resolve => setTimeout(resolve, 10));
    return {
        itemId: item.id,
        subtotalCents: subtotal,
        processed: true,
    };
}).onFail({
    maxRetries: 2,
    delay: 50,
    backoff: 'exponential',
});

// Map combinator with bounded concurrency (prevent connection exhaustion)
const processAllItems = map((ctx: BillingBatchInput) => ctx.items, processInvoiceItem, {
    name: 'processAllInvoiceItems',
    concurrency: 5, // Max 5 items in-flight concurrently
    stopOnError: true, // Halt if any item fails retries
    preserveOrder: true, // Ensure output array matches items order
});

const finalizeBatch = Step.create('finalizeBatch', async (ctx: any) => {
    const processedItems = ctx.processAllInvoiceItems || [];
    const totalCents = processedItems.reduce((sum: number, cur: any) => sum + (cur.subtotalCents || 0), 0);

    return {
        batchStatus: 'COMPLETED',
        totalAmountCents: totalCents,
        processedCount: processedItems.length,
        finalizedAt: new Date().toISOString(),
    };
});

export const batchInvoiceFlow = flow(processAllItems, finalizeBatch);
