import { expect } from 'chai';
import {
    Status,
    FULFILLED,
    REJECTED,
    COMPLETED,
    FAILED,
    CANCELLED,
    RUNNING,
    WAITING,
    PENDING,
    RESUMED,
    EXPIRED,
    CLAIMED,
    IN_PROGRESS,
    isStatus,
} from './Status';

describe('shared.status.unit.test', () => {
    it('Status object exposes all expected status constants', () => {
        expect(Status.FULFILLED).to.equal('fulfilled');
        expect(Status.REJECTED).to.equal('rejected');
        expect(Status.COMPLETED).to.equal('completed');
        expect(Status.FAILED).to.equal('failed');
        expect(Status.CANCELLED).to.equal('cancelled');
        expect(Status.RUNNING).to.equal('running');
        expect(Status.WAITING).to.equal('waiting');
        expect(Status.PENDING).to.equal('pending');
        expect(Status.RESUMED).to.equal('resumed');
        expect(Status.EXPIRED).to.equal('expired');
        expect(Status.CLAIMED).to.equal('claimed');
        expect(Status.IN_PROGRESS).to.equal('in-progress');
    });

    it('Status exports individual named constants matching object properties', () => {
        expect(FULFILLED).to.equal(Status.FULFILLED);
        expect(REJECTED).to.equal(Status.REJECTED);
        expect(COMPLETED).to.equal(Status.COMPLETED);
        expect(FAILED).to.equal(Status.FAILED);
        expect(CANCELLED).to.equal(Status.CANCELLED);
        expect(RUNNING).to.equal(Status.RUNNING);
        expect(WAITING).to.equal(Status.WAITING);
        expect(PENDING).to.equal(Status.PENDING);
        expect(RESUMED).to.equal(Status.RESUMED);
        expect(EXPIRED).to.equal(Status.EXPIRED);
        expect(CLAIMED).to.equal(Status.CLAIMED);
        expect(IN_PROGRESS).to.equal(Status.IN_PROGRESS);
    });

    it('isStatus type guard validates valid and invalid statuses', () => {
        expect(isStatus('completed')).to.be.true;
        expect(isStatus('running')).to.be.true;
        expect(isStatus('failed')).to.be.true;
        expect(isStatus('invalid-status')).to.be.false;
        expect(isStatus(123)).to.be.false;
        expect(isStatus(null)).to.be.false;
        expect(isStatus(undefined)).to.be.false;
        expect(isStatus({})).to.be.false;
    });
});
