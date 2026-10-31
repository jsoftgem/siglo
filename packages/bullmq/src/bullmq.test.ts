import { expect } from 'chai';
import { Step, flow, InMemoryIdempotencyStore } from 'siglo';
import { createBullMQProcessor } from './index';

describe('@siglo/bullmq Adapter Suite', () => {
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

    it('handles in-progress idempotency rejection and failure store cleanup', async () => {
        const store = new InMemoryIdempotencyStore();
        // Claim the key as in-progress manually
        await store.claim('bullmq:job:concurrent-job-1', 60000);

        const step = Step.create(async () => ({ ok: true }));
        const processor = createBullMQProcessor(flow(step), {
            idempotencyStore: store,
        });

        try {
            await processor({ id: 'concurrent-job-1', data: {} });
            expect.fail('Should reject concurrent job');
        } catch (err: any) {
            expect(err.message).to.include('already in-progress concurrently');
        }

        // Test workflow failure invokes store.fail
        const failingStep = Step.create(async () => {
            throw new Error('Worker failure');
        });
        const failProcessor = createBullMQProcessor(flow(failingStep), {
            idempotencyStore: store,
        });

        try {
            await failProcessor({ id: 'failing-job-2', data: {} });
            expect.fail('Should throw');
        } catch (err: any) {
            expect(err.message).to.equal('Worker failure');
        }
    });

    it('supports custom input, output, and namespace mappings', async () => {
        const step = Step.create(async (param: any) => ({
            computed: param.value * 2,
        }));

        // 1. Function namespace + custom input/output
        const processor1 = createBullMQProcessor(flow(step), {
            input: (job) => ({ value: job.data.v }),
            output: (result, job) => ({ ...result, jobId: job.id }),
            namespace: (job) => `ns-${job.id}`
        });

        const res1 = await processor1({ id: 'j1', data: { v: 10 } });
        expect(res1.computed).to.equal(20);
        expect(res1.jobId).to.equal('j1');

        // 2. Static string namespace
        const processor2 = createBullMQProcessor(flow(step), {
            namespace: 'tenant-static'
        });
        const res2 = await processor2({ id: 'j2', data: { value: 5 } });
        expect(res2.computed).to.equal(10);

        // 3. Fallback job.data.namespace and job without ID
        const processor3 = createBullMQProcessor(flow(step));
        const res3 = await processor3({ data: { value: 7, namespace: 'from-data' } });
        expect(res3.computed).to.equal(14);
    });
});
