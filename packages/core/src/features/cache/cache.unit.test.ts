import { expect } from 'chai';
import { Step, flow, clearStorage } from '../../index';
import { cache } from './index';

describe('Step Cache DurationInput & SWR Unit Tests', () => {
    beforeEach(() => {
        clearStorage();
    });

    afterEach(() => {
        clearStorage();
    });

    it('supports DurationInput strings in Step.cache(ttl) and CacheOptions', async () => {
        const s1 = Step.create('cacheDurationStr', () => ({ ok: true })).cache('100ms');
        expect(s1.cachedLast).to.equal(100);

        const s2 = Step.create('cacheObjDuration', () => ({ ok: true })).cache({
            ttl: '250ms',
            swr: '500ms',
        });
        expect(s2.cachedLast).to.equal(250);
        expect(s2.cacheOptions?.ttl).to.equal('250ms');
        expect(s2.cacheOptions?.swr).to.equal('500ms');

        const s3 = Step.create('cacheSwrField', () => ({ ok: true })).cache({
            ttl: 50,
            staleWhileRevalidate: '150ms',
        });
        expect(s3.cachedLast).to.equal(50);
        expect(s3.cacheOptions?.staleWhileRevalidate).to.equal('150ms');

        // Verify Step.cache('100ms') caches during flow execution on same stackId
        let stepCalls = 0;
        const cachedFlowStep = Step.create('cachedFlowStep', () => {
            stepCalls++;
            return { stepCalls };
        }).cache('100ms');

        const f = flow(cachedFlowStep);
        const r1 = await f.run({ k: 1 }, { stackId: 'stack-cache-dur', pojo: true });
        const r2 = await f.run({ k: 1 }, { stackId: 'stack-cache-dur', pojo: true });
        expect(r1.stepCalls).to.equal(1);
        expect(r2.stepCalls).to.equal(1);
        expect(stepCalls).to.equal(1);
    });

    it('uses DurationInput strings for swr and staleWhileRevalidate during cache execution', async () => {
        let calls = 0;
        const action = async () => {
            calls++;
            return { count: calls };
        };

        const stackId = 'swr-duration-stack';
        const first = await cache(stackId, 'step1', {}, 25, action, undefined, { swr: '200ms' });
        expect(first.count).to.equal(1);

        // Wait past TTL (25ms) but within SWR window (200ms)
        await new Promise(r => setTimeout(r, 40));
        const stale = cache(stackId, 'step1', {}, 25, action, undefined, { swr: '200ms' });
        expect(stale.count).to.equal(1); // Stale value served immediately while revalidating

        // Wait for background revalidation microtask to finish
        await new Promise(r => setTimeout(r, 20));
        const fresh = cache(stackId, 'step1', {}, 25, action, undefined, { swr: '200ms' });
        expect(fresh.count).to.equal(2);
    });

    it('uses DurationInput strings for staleWhileRevalidate field during cache execution', async () => {
        let calls = 0;
        const action = async () => {
            calls++;
            return { count: calls };
        };

        const stackId = 'swr-longname-duration-stack';
        const first = await cache(stackId, 'step2', {}, 25, action, undefined, {
            staleWhileRevalidate: '200ms',
        });
        expect(first.count).to.equal(1);

        await new Promise(r => setTimeout(r, 40));
        const stale = cache(stackId, 'step2', {}, 25, action, undefined, {
            staleWhileRevalidate: '200ms',
        });
        expect(stale.count).to.equal(1);

        await new Promise(r => setTimeout(r, 20));
        const fresh = cache(stackId, 'step2', {}, 25, action, undefined, {
            staleWhileRevalidate: '200ms',
        });
        expect(fresh.count).to.equal(2);
    });
});
