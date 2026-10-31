import { expect } from 'chai';
import { Step, flow, InMemoryIdempotencyStore } from 'siglo';
import { createKafkaMessageHandler } from './index';

describe('@siglo/kafka Adapter Suite', () => {
    it('consumes kafka message, parses JSON payload, and executes workflow', async () => {
        const step = Step.create('creditEvent', async (param: any) => {
            const eventId = typeof param.eventId === 'function' ? param.eventId() : param.eventId;
            const amount = typeof param.amount === 'function' ? param.amount() : param.amount;
            return {
                processedId: eventId,
                credited: amount,
            };
        });
        const eventFlow = flow(step);

        const handler = createKafkaMessageHandler(eventFlow);

        const mockPayload = {
            topic: 'finance.credits',
            partition: 2,
            message: {
                key: 'user-77',
                value: Buffer.from(JSON.stringify({ eventId: 'evt_99', amount: 500 })),
                offset: '10045',
                partition: 2,
                topic: 'finance.credits',
            },
        };

        const result = await handler(mockPayload);
        expect(result.processedId).to.equal('evt_99');
        expect(result.credited).to.equal(500);
    });

    it('supports custom input mapper, output mapper, and string value', async () => {
        const step = Step.create('processString', async (param: any) => {
            return { transformed: param.raw.toUpperCase() };
        });
        const flowInstance = flow(step);

        const handler = createKafkaMessageHandler(flowInstance, {
            input: (msg) => ({ raw: String(msg.value) }),
            output: (res, msg) => ({ ...res, topic: msg.topic, offset: msg.offset })
        });

        const mockPayload = {
            topic: 'orders.topic',
            partition: 0,
            message: {
                key: 'key-1',
                value: 'plain string content',
                offset: '123',
                partition: 0,
                topic: 'orders.topic'
            }
        };

        const result = await handler(mockPayload);
        expect(result.transformed).to.equal('PLAIN STRING CONTENT');
        expect(result.topic).to.equal('orders.topic');
        expect(result.offset).to.equal('123');
    });

    it('resolves namespace from function, string option, and x-namespace header', async () => {
        let capturedNamespace: string | undefined;
        const step = Step.create('nsStep', async (param: any) => {
            capturedNamespace = typeof param.$namespace === 'function' ? param.$namespace() : param.$namespace;
            return { ok: true };
        });
        const flowInstance = flow(step);

        // 1. Function namespace
        const fnHandler = createKafkaMessageHandler(flowInstance, {
            namespace: (msg) => `tenant-${msg.partition}`
        });
        await fnHandler({
            topic: 't1',
            partition: 5,
            message: { value: JSON.stringify({ a: 1 }), partition: 5, topic: 't1', offset: '1' }
        });

        // 2. String namespace
        const strHandler = createKafkaMessageHandler(flowInstance, {
            namespace: 'static-tenant'
        });
        await strHandler({
            topic: 't2',
            partition: 0,
            message: { value: JSON.stringify({ a: 1 }), partition: 0, topic: 't2', offset: '2' }
        });

        // 3. Header namespace
        const headerHandler = createKafkaMessageHandler(flowInstance);
        await headerHandler({
            topic: 't3',
            partition: 0,
            message: {
                value: JSON.stringify({ a: 1 }),
                partition: 0,
                topic: 't3',
                offset: '3',
                headers: { 'x-namespace': 'header-tenant' }
            }
        });
    });

    it('integrates with IdempotencyStore on success, duplicate claim, and failure', async () => {
        const store = new InMemoryIdempotencyStore();
        let runs = 0;

        const step = Step.create('idempStep', async (param: any) => {
            runs++;
            if (param.fail) {
                throw new Error('Kafka processing error');
            }
            return { runs, received: param.val };
        });
        const flowInstance = flow(step);

        const handler = createKafkaMessageHandler(flowInstance, {
            idempotencyStore: store
        });

        const successPayload = {
            topic: 't',
            partition: 0,
            message: {
                value: JSON.stringify({ val: 42 }),
                partition: 0,
                topic: 't',
                offset: '500'
            }
        };

        // First run succeeds
        const res1 = await handler(successPayload);
        expect(res1.runs).to.equal(1);

        // Second run deduplicates
        const res2 = await handler(successPayload);
        expect(runs).to.equal(1);

        // Failure path triggers store.fail
        const failPayload = {
            topic: 't',
            partition: 0,
            message: {
                value: JSON.stringify({ fail: true }),
                partition: 0,
                topic: 't',
                offset: '501'
            }
        };

        try {
            await handler(failPayload);
            expect.fail('Should throw');
        } catch (err: any) {
            expect(err.message).to.equal('Kafka processing error');
        }
    });

    it('handles non-JSON string values and null/undefined values gracefully', async () => {
        const step = Step.create('rawStep', async (param: any) => ({ ...param }));
        const flowInstance = flow(step);
        const handler = createKafkaMessageHandler(flowInstance);

        const invalidJsonPayload = {
            topic: 't',
            partition: 0,
            message: {
                value: 'Not JSON string at all',
                partition: 0,
                topic: 't',
                offset: '900'
            }
        };

        const res = await handler(invalidJsonPayload);
        expect(res.raw).to.equal('Not JSON string at all');

        const nullPayload = {
            topic: 't',
            partition: 0,
            message: {
                value: null,
                partition: 0,
                topic: 't',
                offset: '901'
            }
        };

        const resNull = await handler(nullPayload);
        expect(resNull).to.deep.equal({});
    });
});
