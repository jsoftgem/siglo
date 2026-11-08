import { expect } from 'chai';
import { Step, flow, InMemoryIdempotencyStore } from '@siglo/core';
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
        const flaky = Step.create('flaky', async () => {
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

    it('integrates with IdempotencyStore on completed skip and failure recovery', async () => {
        const store = new InMemoryIdempotencyStore();
        let executedCount = 0;

        const step = Step.create('idempSqs', async (param: any) => {
            executedCount++;
            if (param.fail) {
                throw new Error('SQS step error');
            }
            return { processed: true };
        });
        const flowInstance = flow(step);

        const handler = createSqsBatchHandler(flowInstance, {
            idempotencyStore: store,
        });

        const event = {
            Records: [
                {
                    messageId: 'sqs-dup-1',
                    receiptHandle: 'rcpt-1',
                    body: JSON.stringify({ fail: false }),
                },
            ],
        };

        // First run succeeds and completes
        const res1 = await handler(event);
        expect(res1.processedCount).to.equal(1);
        expect(executedCount).to.equal(1);

        // Second run with same messageId deduplicates
        const res2 = await handler(event);
        expect(res2.processedCount).to.equal(1);
        expect(executedCount).to.equal(1);

        // Third run with failure
        const failEvent = {
            Records: [
                {
                    messageId: 'sqs-fail-1',
                    receiptHandle: 'rcpt-f',
                    body: JSON.stringify({ fail: true }),
                },
            ],
        };
        const res3 = await handler(failEvent);
        expect(res3.processedCount).to.equal(0);
        expect(res3.batchItemFailures).to.deep.equal([{ itemIdentifier: 'sqs-fail-1' }]);
    });

    it('supports custom input mapper, fallback non-JSON string body, and namespace resolution', async () => {
        const step = Step.create('customSqs', async (param: any) => {
            return {
                transformed: param.value || param.body,
                ns: typeof param.$namespace === 'function' ? param.$namespace() : param.$namespace,
            };
        });

        // 1. Custom input & function namespace
        const handler1 = createSqsBatchHandler(flow(step), {
            input: record => ({ value: `custom_${record.messageId}` }),
            namespace: record => `ns_${record.receiptHandle}`,
        });
        const res1 = await handler1({
            Records: [{ messageId: 'm1', receiptHandle: 'rh1', body: 'ignored' }],
        });
        expect(res1.processedCount).to.equal(1);

        // 2. Fallback non-JSON body and messageAttributes namespace
        const handler2 = createSqsBatchHandler(flow(step));
        const res2 = await handler2({
            Records: [
                {
                    messageId: 'm2',
                    receiptHandle: 'rh2',
                    body: 'Plain unparseable string',
                    messageAttributes: { namespace: { stringValue: 'attr-namespace' } },
                },
            ],
        });
        expect(res2.processedCount).to.equal(1);

        // 3. Static string namespace
        const handler3 = createSqsBatchHandler(flow(step), {
            namespace: 'static-sqs-ns',
        });
        const res3 = await handler3({
            Records: [{ messageId: 'm3', receiptHandle: 'rh3', body: JSON.stringify({ value: 'hello' }) }],
        });
        expect(res3.processedCount).to.equal(1);

        // 4. Empty records fallback
        const emptyRes = await handler3({} as any);
        expect(emptyRes.processedCount).to.equal(0);
    });
});
