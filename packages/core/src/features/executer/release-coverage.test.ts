import { expect } from 'chai';
import { Step } from '../step';
import { SigloError, OptimisticLockException, NetworkPolicyViolationException } from './exceptions';

describe('Error serialization and validation boundaries', () => {
    it('serializes plain causes and falls back safely for circular causes', () => {
        const cause = { code: 'UNAVAILABLE', details: { retryAfter: 5 } };
        const serialized = new SigloError('failed', { cause }).toJSON();
        expect(serialized.cause).to.deep.equal(cause);
        expect(serialized.cause).not.to.equal(cause);
        const circular: any = { code: 'CIRCULAR' };
        circular.self = circular;
        expect(new SigloError('failed', { cause: circular }).toJSON().cause).to.equal('[object Object]');
    });

    it('preserves conflict versions and checkpoint metadata', () => {
        const error = new OptimisticLockException('stack-conflict', 3, 2, { namespace: 'orders' });
        expect(error).to.be.instanceOf(SigloError);
        expect(error.currentVersion).to.equal(3);
        expect(error.expectedVersion).to.equal(2);
        expect(error.toJSON()).to.include({
            name: 'OptimisticLockException', stackId: 'stack-conflict',
            namespace: 'orders', phase: 'checkpoint', retryable: true
        });
    });

    it('preserves nested network violations from validators and never executes the action', async () => {
        const violation = new NetworkPolicyViolationException('validate-target', 'https://blocked.example', 'blocked.example', []);
        let executed = false;
        const step = new Step('validate-target', () => { executed = true; })
            .spec('target', { validate: () => Promise.reject({ error: { error: violation } }) });
        try {
            await step.execute({ target: 'blocked.example' });
            expect.fail('Expected validation to reject');
        } catch (error: any) {
            expect(error === violation || error.error === violation).to.equal(true);
        }
        expect(executed).to.equal(false);
    });
});
