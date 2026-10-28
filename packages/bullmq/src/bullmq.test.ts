import { expect } from 'chai';
import { Step, flow, InMemoryIdempotencyStore } from 'rivulet';
import { createBullMQProcessor } from './index';

describe('@rivulet/bullmq Adapter Suite', () => {
    it('processes job and returns workflow output', async () => {
        const step = Step.create(async ({ imageId }: { imageId: string }) => ({
            processed: true,
            cdnUrl: `https://cdn.example.com/${imageId}.jpg`,
        }));
        const imageFlow = flow(step);

        const processor = createBullMQProcessor(imageFlow);

        const mockJob = {
            id: 'job-987',
            data: { imageId: 'img_42' },
        };

        const result = await processor(mockJob);
        expect(result.processed).to.be.true;
        expect(result.cdnUrl).to.equal('https://cdn.example.com/img_42.jpg');
    });

    it('integrates with IdempotencyStore to deduplicate duplicate jobs', async () => {
        const store = new InMemoryIdempotencyStore();
        let executions = 0;

        const step = Step.create(async () => {
            executions++;
            return { executed: true };
        });
        const idempotentFlow = flow(step);

        const processor = createBullMQProcessor(idempotentFlow, {
            idempotencyStore: store,
        });

        const mockJob = {
            id: 'unique-job-1',
            data: {},
        };

        const result1 = await processor(mockJob);
        expect(result1.executed).to.be.true;
        expect(executions).to.equal(1);

        // Re-running same job id should deduplicate and avoid second execution
        const result2 = await processor(mockJob);
        expect(executions).to.equal(1);
    });
});
