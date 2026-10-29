import { expect } from 'chai';
import { Step, flow } from 'siglo';
import { createSqsBatchHandler } from './index';

describe('@siglo/sqs Adapter Suite', () => {
    it('processes SQS message records successfully', async () => {
        const step = Step.create('sqsStep', async (param: any) => {
            const orderId = typeof param.orderId === 'function' ? param.orderId() : param.orderId;
            return {
                dispatched: true,
                orderId,
            };
        });
        const orderFlow = flow(step);

        const handler = createSqsBatchHandler(orderFlow);

        const mockEvent = {
            Records: [
                {
                    messageId: 'msg-001',
                    receiptHandle: 'rcpt-001',
                    body: JSON.stringify({ orderId: 'ord_123' }),
                },
                {
                    messageId: 'msg-002',
                    receiptHandle: 'rcpt-002',
                    body: JSON.stringify({ orderId: 'ord_456' }),
                },
            ],
        };

        const response = await handler(mockEvent);
        expect(response.processedCount).to.equal(2);
        expect(response.batchItemFailures).to.have.lengthOf(0);
    });

    it('collects batch item failures without interrupting remaining records', async () => {
        let count = 0;
        const flaky = Step.create('flaky', async (param: any) => {
            count++;
            if (count === 1) {
                throw new Error('Dead letter condition');
            }
            return { ok: true };
        });
        const flakyFlow = flow(flaky);

        const handler = createSqsBatchHandler(flakyFlow);

        const mockEvent = {
            Records: [
                {
                    messageId: 'bad-msg-1',
                    receiptHandle: 'rcpt-bad',
                    body: JSON.stringify({ item: 1 }),
                },
                {
                    messageId: 'good-msg-2',
                    receiptHandle: 'rcpt-good',
                    body: JSON.stringify({ item: 2 }),
                },
            ],
        };

        const response = await handler(mockEvent);
        expect(response.processedCount).to.equal(1);
        expect(response.batchItemFailures).to.deep.equal([{ itemIdentifier: 'bad-msg-1' }]);
    });
});
