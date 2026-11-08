import { strict as assert } from 'node:assert';
import {
    flow,
    Step,
    resumeWorkflow,
    useStorage,
    defaultDurableManager,
    ExpiredWaitException,
    WorkflowAlreadyResumedException,
} from '../../..';
describe('durable acceptance safety', () => {
    afterEach(() => {
        useStorage(undefined as any);
        defaultDurableManager.clear();
    });
    const record = {
        stackId: 'safety-stack',
        correlationKey: 'safety-key',
        status: 'WAITING',
        continuationStepIndex: 0,
    };
    it('checks cancellation inside the workflow lock before claiming', async () => {
        let locked = false;
        useStorage({
            name: 'safety',
            getWaitRecord: async () => record,
            withWorkflowLock: async (_: string, action: any) => {
                locked = true;
                return action();
            },
            getCheckpoint: async () => {
                assert.equal(locked, true);
                return { status: 'cancelled' };
            },
            claimWaitRecord: async () => {
                throw new Error('must not claim a cancelled stack');
            },
        } as any);
        await assert.rejects(
            resumeWorkflow(flow(new Step('effect', async () => ({}))), 'safety-key'),
            WorkflowAlreadyResumedException,
        );
    });
    it('does not swallow expiry validation from a storage claim', async () => {
        useStorage({
            name: 'safety',
            getWaitRecord: async () => record,
            claimWaitRecord: async () => ({ ...record, expiresAt: 0 }),
        } as any);
        await assert.rejects(
            resumeWorkflow(flow(new Step('effect', async () => ({}))), 'safety-key'),
            ExpiredWaitException,
        );
    });
});
