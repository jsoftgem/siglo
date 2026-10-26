import { expect } from 'chai';
import { Step, flow } from 'fluid-func';
import { createKafkaMessageHandler } from './index';

describe('@fluid-func/kafka Adapter Suite', () => {
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
});
