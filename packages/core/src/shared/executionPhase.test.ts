import { expect } from 'chai';
import { ExecutionPhase, tagErrorPhase } from './ExecutionPhase';

describe('shared.executionPhase.unit.test', () => {
    it('defines standard execution phase constants', () => {
        expect(ExecutionPhase.VALIDATION).to.equal('validation');
        expect(ExecutionPhase.BEFORE).to.equal('before');
        expect(ExecutionPhase.ACTION).to.equal('action');
        expect(ExecutionPhase.AFTER).to.equal('after');
        expect(ExecutionPhase.FAIL).to.equal('fail');
    });

    it('tagErrorPhase tags error with phase and stepName on objects', () => {
        const err: any = new Error('Test error');
        tagErrorPhase(err, ExecutionPhase.ACTION, 'myStep');
        expect(err.phase).to.equal('action');
        expect(err.stepName).to.equal('myStep');

        const obj: any = {};
        tagErrorPhase(obj, ExecutionPhase.VALIDATION);
        expect(obj.phase).to.equal('validation');
        expect(obj.stepName).to.be.undefined;
    });

    it('tagErrorPhase recursively tags arrays and nested error objects', () => {
        const nestedErr: any = new Error('nested');
        const errArray: any = [{ field: 'testField', error: nestedErr }];
        tagErrorPhase(errArray, ExecutionPhase.VALIDATION, 'specStep');
        expect(errArray.phase).to.equal('validation');
        expect(errArray.stepName).to.equal('specStep');
        expect(errArray[0].phase).to.equal('validation');
        expect(errArray[0].stepName).to.equal('specStep');
        expect(nestedErr.phase).to.equal('validation');
        expect(nestedErr.stepName).to.equal('specStep');
    });

    it('tagErrorPhase safely ignores non-object inputs', () => {
        expect(() => tagErrorPhase('string error', ExecutionPhase.FAIL)).to.not.throw();
        expect(() => tagErrorPhase(null, ExecutionPhase.FAIL)).to.not.throw();
        expect(() => tagErrorPhase(undefined, ExecutionPhase.FAIL)).to.not.throw();
    });
});
