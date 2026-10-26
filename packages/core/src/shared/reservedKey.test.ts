import { expect } from 'chai';
import {
    ReservedKey,
    isReservedKey,
    STEPS,
    HISTORY,
    SIGNAL,
    CHAIN_ID,
    STACK_ID,
    NAMESPACE,
    VALIDATORS,
    STACK_ID_KEY,
    SIGNAL_KEY,
    NAMESPACE_KEY,
    STEP_ID,
    ATTEMPT,
    RETRY_DELAY,
    IS_DURABLE,
    WORKFLOW_ID,
    BRANCH_SELECTED,
    SKIPPED_BRANCHES,
    SKIPPED,
    BRANCHES,
    SETTLED_KEY,
    TIMING,
    VALUE
} from './ReservedKey';

describe('shared.reservedKey.unit.test', () => {
    it('isReservedKey identifies core reserved keys properly', () => {
        expect(isReservedKey('$steps')).to.be.true;
        expect(isReservedKey('$history')).to.be.true;
        expect(isReservedKey('$signal')).to.be.true;
        expect(isReservedKey('$chainId')).to.be.true;
        expect(isReservedKey('$stackId')).to.be.true;
        expect(isReservedKey('$namespace')).to.be.true;
        expect(isReservedKey('$$$validators')).to.be.true;
        expect(isReservedKey('stackId')).to.be.true;
        expect(isReservedKey('signal')).to.be.true;
        expect(isReservedKey('namespace')).to.be.true;
        expect(isReservedKey('$stepId')).to.be.true;

        expect(isReservedKey('customField')).to.be.false;
        expect(isReservedKey('item')).to.be.false;
        expect(isReservedKey('')).to.be.false;
    });

    it('exports all context and execution reserved keys with correct values', () => {
        expect(STEPS).to.equal('$steps');
        expect(HISTORY).to.equal('$history');
        expect(SIGNAL).to.equal('$signal');
        expect(CHAIN_ID).to.equal('$chainId');
        expect(STACK_ID).to.equal('$stackId');
        expect(NAMESPACE).to.equal('$namespace');
        expect(VALIDATORS).to.equal('$$$validators');

        expect(STACK_ID_KEY).to.equal('stackId');
        expect(SIGNAL_KEY).to.equal('signal');
        expect(NAMESPACE_KEY).to.equal('namespace');

        expect(STEP_ID).to.equal('$stepId');
        expect(ATTEMPT).to.equal('$attempt');
        expect(RETRY_DELAY).to.equal('$retryDelay');
        expect(IS_DURABLE).to.equal('$isDurable');
        expect(WORKFLOW_ID).to.equal('$workflowId');
        expect(BRANCH_SELECTED).to.equal('$branchSelected');
        expect(SKIPPED_BRANCHES).to.equal('$skippedBranches');
        expect(SKIPPED).to.equal('$skipped');
        expect(BRANCHES).to.equal('$branches');
        expect(SETTLED_KEY).to.equal('$settled');
        expect(TIMING).to.equal('$timing');
        expect(VALUE).to.equal('value');
    });

    it('ReservedKey object exposes properties matching constants', () => {
        expect(ReservedKey.STEPS).to.equal(STEPS);
        expect(ReservedKey.SIGNAL).to.equal(SIGNAL);
        expect(ReservedKey.CHAIN_ID).to.equal(CHAIN_ID);
        expect(ReservedKey.VALUE).to.equal(VALUE);
    });
});
