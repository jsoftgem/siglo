import { logInfo, logError, createLog } from './index';
import Step from '../../index';
import { expect } from 'chai';

describe('logger.unit.test', () => {
    it('should log info', () => {
        let called = false;
        Step.config({
            logMonitor: (monitor: any) => {
                expect(monitor.source).to.be.equal('sampleChain');
                expect(monitor.message).to.be.equal('first log');
                called = true;
            }
        });
        logInfo('sampleChain', 'first log');
        expect(called).to.be.true;
    });

    it('should log error', () => {
        let called = false;
        Step.config({
            logMonitor: (monitor: any) => {
                expect(monitor.source).to.be.equal('sampleChain');
                expect(monitor.message).to.be.equal('first error');
                called = true;
            }
        });
        try {
            throw new Error('first error');
        } catch (error) {
            logError('sampleChain', error);
        }
        expect(called).to.be.true;
    });

    it('createLog creates log entry', () => {
        const entry = createLog('mySource', 'myMessage', 'myError');
        expect(entry.source).to.equal('mySource');
        expect(entry.message).to.equal('myMessage');
        expect(entry.error).to.equal('myError');
    });
});
