import { expect } from 'chai';
import { EventEmitter } from 'events';
import { InvariantEvaluator, InvariantViolation } from './invariant-evaluator';

describe('InvariantEvaluator Unit Tests', () => {
    describe('InvariantViolation class', () => {
        it('constructs an InvariantViolation with properties', () => {
            const err = new InvariantViolation(1, 'Test Oracle', 'Something failed', { foo: 'bar' });
            expect(err.name).to.equal('InvariantViolation');
            expect(err.oracleNumber).to.equal(1);
            expect(err.oracleName).to.equal('Test Oracle');
            expect(err.message).to.include('[Oracle 1: Test Oracle]');
            expect(err.message).to.include('Something failed');
            expect(err.details).to.deep.equal({ foo: 'bar' });
        });
    });

    describe('Oracle 1: assertContextImmutability', () => {
        it('passes when context is intact and no prototype pollution', () => {
            expect(() => {
                InvariantEvaluator.assertContextImmutability({ a: 1, nested: { b: 2 } }, { a: 1, nested: { b: 2 } });
            }).to.not.throw();
        });

        it('ignores keys starting with $ or null/undefined beforeSnapshot', () => {
            expect(() => {
                InvariantEvaluator.assertContextImmutability(null, { a: 1 });
                InvariantEvaluator.assertContextImmutability({ $internal: { secret: 123 } }, { $internal: { secret: 456 } });
                InvariantEvaluator.assertContextImmutability({ a: 123 }, null);
            }).to.not.throw();
        });

        it('detects and cleans up prototype pollution canary property', () => {
            (Object.prototype as any)['canary'] = 'polluted';
            try {
                expect(() => {
                    InvariantEvaluator.assertContextImmutability({}, {});
                }).to.throw(InvariantViolation).with.property('oracleNumber', 1);
            } finally {
                delete (Object.prototype as any)['canary'];
            }
        });

        it('detects custom canary key pollution', () => {
            (Object.prototype as any)['customCanary'] = 'evil';
            try {
                expect(() => {
                    InvariantEvaluator.assertContextImmutability({}, {}, 'customCanary');
                }).to.throw(InvariantViolation).with.property('oracleNumber', 1);
            } finally {
                delete (Object.prototype as any)['customCanary'];
            }
        });

        it('detects ancestor snapshot mutation in nested object', () => {
            const before = { config: { timeout: 100 } };
            const after = { config: { timeout: 999 } };
            expect(() => {
                InvariantEvaluator.assertContextImmutability(before, after);
            }).to.throw(InvariantViolation).with.property('oracleNumber', 1);
        });

        it('handles non-object properties and circular references gracefully', () => {
            const circular: any = { a: 1 };
            circular.self = circular;
            expect(() => {
                InvariantEvaluator.assertContextImmutability({ num: 42, str: 'hello', emptyObj: {}, emptyArr: [] }, { num: 42, str: 'hello', emptyObj: {}, emptyArr: [] });
                InvariantEvaluator.assertContextImmutability({ circ: circular }, { circ: circular });
                InvariantEvaluator.assertContextImmutability({ val: null }, { val: null });
            }).to.not.throw();
        });

        it('normalizes POJO-converted array objects correctly', () => {
            expect(() => {
                InvariantEvaluator.assertContextImmutability(
                    { list: [10, 20, 30] },
                    { list: { '0': 10, '1': 20, '2': 30 } }
                );
            }).to.not.throw();

            expect(() => {
                InvariantEvaluator.assertContextImmutability(
                    { list: [10, 20, 30] },
                    { list: { '0': 10, '1': 999, '2': 30 } }
                );
            }).to.throw(InvariantViolation).with.property('oracleNumber', 1);

            expect(() => {
                InvariantEvaluator.assertContextImmutability(
                    { map: { a: 1, b: 2 } },
                    { map: { a: 1, b: 2 } }
                );
            }).to.not.throw();
        });
    });

    describe('Oracle 2: assertSagaLIFO', () => {
        it('passes when compensations match exact reverse completed order', () => {
            expect(() => {
                InvariantEvaluator.assertSagaLIFO(['stepA', 'stepB', 'stepC'], ['stepC', 'stepB', 'stepA']);
            }).to.not.throw();
        });

        it('passes when compensations are a valid prefix of reverse order', () => {
            expect(() => {
                InvariantEvaluator.assertSagaLIFO(['stepA', 'stepB', 'stepC'], ['stepC', 'stepB']);
                InvariantEvaluator.assertSagaLIFO(['stepA'], ['stepA'], undefined);
                InvariantEvaluator.assertSagaLIFO(['stepA'], ['stepA'], 'differentStep');
            }).to.not.throw();
        });

        it('throws when compensations are executed out-of-order and records details', () => {
            try {
                InvariantEvaluator.assertSagaLIFO(['stepA', 'stepB', 'stepC'], ['stepB', 'stepC'], 'stepX');
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err).to.be.instanceOf(InvariantViolation);
                expect(err.oracleNumber).to.equal(2);
                expect(err.details).to.have.property('completedSteps');
                expect(err.details).to.have.property('compensatedSteps');
                expect(err.details).to.have.property('failedStep', 'stepX');
            }
        });

        it('throws when failed step compensation is triggered and records details', () => {
            try {
                InvariantEvaluator.assertSagaLIFO(['stepA', 'stepB'], ['stepB', 'stepA'], 'stepB');
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err).to.be.instanceOf(InvariantViolation);
                expect(err.oracleNumber).to.equal(2);
                expect(err.details).to.have.property('failedStep', 'stepB');
                expect(err.details).to.have.property('compensatedSteps');
            }
        });
    });

    describe('Oracle 3: assertOptimisticConcurrency', () => {
        it('passes when zero or single writer fulfills', () => {
            expect(() => {
                InvariantEvaluator.assertOptimisticConcurrency([]);
                InvariantEvaluator.assertOptimisticConcurrency([
                    { status: 'rejected', reason: new Error('Network error') },
                ]);
                InvariantEvaluator.assertOptimisticConcurrency([
                    { status: 'fulfilled', value: { ok: true } },
                    { status: 'rejected', reason: new Error('OCC Conflict') },
                ]);
            }).to.not.throw();
        });

        it('passes when multiple writers fulfill with identical idempotent values', () => {
            expect(() => {
                InvariantEvaluator.assertOptimisticConcurrency([
                    { status: 'fulfilled', value: { token: 'abc' } },
                    { status: 'fulfilled', value: { token: 'abc' } },
                ]);
            }).to.not.throw();
        });

        it('throws when multiple writers fulfill with divergent outputs and records details', () => {
            try {
                InvariantEvaluator.assertOptimisticConcurrency([
                    { status: 'fulfilled', value: { token: 'abc' } },
                    { status: 'fulfilled', value: { token: 'xyz' } },
                    { status: 'rejected', reason: new Error('Conflict') }
                ]);
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err).to.be.instanceOf(InvariantViolation);
                expect(err.oracleNumber).to.equal(3);
                expect(err.details).to.have.property('results');
                expect(err.details).to.have.property('rejectedCount', 1);
            }
        });
    });

    describe('Oracle 4: assertCancellationPromptness', () => {
        it('passes when no subsequent steps execute after cancellation', () => {
            expect(() => {
                InvariantEvaluator.assertCancellationPromptness('step1', ['step1'], ['step2', 'step3']);
                InvariantEvaluator.assertCancellationPromptness('step1', ['step1'], []);
            }).to.not.throw();
        });

        it('throws when a step scheduled after abort was executed and records details', () => {
            try {
                InvariantEvaluator.assertCancellationPromptness('step1', ['step1', 'step2'], ['step2', 'step3']);
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err).to.be.instanceOf(InvariantViolation);
                expect(err.oracleNumber).to.equal(4);
                expect(err.details).to.have.property('abortedStepName', 'step1');
                expect(err.details).to.have.property('allExecutedSteps');
                expect(err.details).to.have.property('stepsDefinedAfterAbort');
            }
        });
    });

    describe('Oracle 5: assertBoundedConcurrency', () => {
        it('passes when highWaterMark is within maxAllowed', () => {
            expect(() => {
                InvariantEvaluator.assertBoundedConcurrency(0, 0);
                InvariantEvaluator.assertBoundedConcurrency(3, 5);
                InvariantEvaluator.assertBoundedConcurrency(5, 5);
            }).to.not.throw();
        });

        it('throws when highWaterMark exceeds maxAllowed and records details', () => {
            try {
                InvariantEvaluator.assertBoundedConcurrency(6, 5);
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err).to.be.instanceOf(InvariantViolation);
                expect(err.oracleNumber).to.equal(5);
                expect(err.details).to.have.property('highWaterMark', 6);
                expect(err.details).to.have.property('maxAllowed', 5);
            }
        });
    });

    describe('Oracle 6: assertCombinatorSoundness', () => {
        it('passes for non-allSettled and non-map combinators without false positives', () => {
            expect(() => {
                InvariantEvaluator.assertCombinatorSoundness('race', { winner: 'A' }, { branchCount: 2 });
                InvariantEvaluator.assertCombinatorSoundness('parallel', { ok: true }, { branchCount: 3 });
                InvariantEvaluator.assertCombinatorSoundness('when', { branched: true }, {});
            }).to.not.throw();
        });

        it('passes for valid allSettled result', () => {
            expect(() => {
                InvariantEvaluator.assertCombinatorSoundness('allSettled', { b1: 1, b2: 2 }, { branchCount: 2 });
                InvariantEvaluator.assertCombinatorSoundness('allSettled', { b1: 1 }, {});
                InvariantEvaluator.assertCombinatorSoundness('allSettled', [1, 2], { branchCount: 2 });
            }).to.not.throw();
        });

        it('throws for allSettled when branches are missing', () => {
            expect(() => {
                InvariantEvaluator.assertCombinatorSoundness('allSettled', { b1: 1 }, { branchCount: 2 });
            }).to.throw(InvariantViolation).with.property('oracleNumber', 6);
        });

        it('passes for valid map result length', () => {
            expect(() => {
                InvariantEvaluator.assertCombinatorSoundness('map', [10, 20, 30], { branchCount: 3 });
                InvariantEvaluator.assertCombinatorSoundness('map', [10, 20], {});
                InvariantEvaluator.assertCombinatorSoundness('map', 'not-array' as any, { branchCount: 3 });
            }).to.not.throw();
        });

        it('throws for map when output length does not match input length', () => {
            expect(() => {
                InvariantEvaluator.assertCombinatorSoundness('map', [10, 20], { branchCount: 3 });
            }).to.throw(InvariantViolation).with.property('oracleNumber', 6);
        });
    });

    describe('Oracle 7: assertBatchPartition', () => {
        it('passes when ACKed and NACKed form a valid partition', () => {
            expect(() => {
                InvariantEvaluator.assertBatchPartition(['m1', 'm2', 'm3'], ['m1', 'm3'], ['m2']);
            }).to.not.throw();
        });

        it('throws when an item is in both ACKed and NACKed and records details', () => {
            try {
                InvariantEvaluator.assertBatchPartition(['m1', 'm2'], ['m1', 'm2'], ['m2']);
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err).to.be.instanceOf(InvariantViolation);
                expect(err.oracleNumber).to.equal(7);
                expect(err.details).to.have.property('id', 'm2');
                expect(err.details).to.have.property('ackedItems');
                expect(err.details).to.have.property('nackedItems');
            }
        });

        it('throws when an item is dropped and records details', () => {
            try {
                InvariantEvaluator.assertBatchPartition(['m1', 'm2', 'm3'], ['m1'], ['m2']);
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err).to.be.instanceOf(InvariantViolation);
                expect(err.oracleNumber).to.equal(7);
                expect(err.details).to.have.property('id', 'm3');
                expect(err.details).to.have.property('allItems');
            }
        });
    });

    describe('Oracle 8: assertTimeoutType', () => {
        class StepTimeoutException extends Error {
            name = 'StepTimeoutException';
        }
        class FlowTimeoutException extends Error {
            name = 'FlowTimeoutException';
        }

        it('passes for matching step timeout error', () => {
            expect(() => {
                InvariantEvaluator.assertTimeoutType(new StepTimeoutException('step timed out'), 'step');
                // Error without .name property but with constructor name
                const customErr = Object.create({ constructor: { name: 'StepTimeoutException' } });
                customErr.message = 'timed out';
                InvariantEvaluator.assertTimeoutType(customErr, 'step');
            }).to.not.throw();
        });

        it('passes for matching flow timeout error', () => {
            expect(() => {
                InvariantEvaluator.assertTimeoutType(new FlowTimeoutException('flow timed out'), 'flow');
                const customFlowErr = Object.create({ constructor: { name: 'FlowTimeoutException' } });
                customFlowErr.message = 'flow timed out';
                InvariantEvaluator.assertTimeoutType(customFlowErr, 'flow');
            }).to.not.throw();
        });

        it('throws when error is missing', () => {
            expect(() => {
                InvariantEvaluator.assertTimeoutType(null, 'step');
            }).to.throw(InvariantViolation).with.property('oracleNumber', 8);
        });

        it('throws when expected step timeout but received generic or other error', () => {
            expect(() => {
                InvariantEvaluator.assertTimeoutType(new Error('something else'), 'step');
            }).to.throw(InvariantViolation).with.property('oracleNumber', 8);

            expect(() => {
                const bareErr = Object.create(null);
                bareErr.message = 'bare';
                InvariantEvaluator.assertTimeoutType(bareErr, 'step');
            }).to.throw(InvariantViolation).with.property('oracleNumber', 8);
        });

        it('throws when expected flow timeout but received step timeout', () => {
            expect(() => {
                InvariantEvaluator.assertTimeoutType(new StepTimeoutException('step'), 'flow');
            }).to.throw(InvariantViolation).with.property('oracleNumber', 8);
        });
    });

    describe('Oracle 9: assertSpanContinuity', () => {
        it('passes for empty trace or valid root and child spans', () => {
            expect(() => {
                InvariantEvaluator.assertSpanContinuity([]);
                InvariantEvaluator.assertSpanContinuity([
                    { id: 'root', name: 'root-span' },
                    { id: 'child-1', parentId: 'root', name: 'step-1' },
                    { id: 'child-2', parentId: 'root', name: 'step-2' },
                ]);
            }).to.not.throw();
        });

        it('throws when non-empty spans have no root span (e.g. cyclic spans without a root)', () => {
            expect(() => {
                InvariantEvaluator.assertSpanContinuity([
                    { id: 'span-a', parentId: 'span-b', name: 'span-a' },
                    { id: 'span-b', parentId: 'span-a', name: 'span-b' },
                ]);
            }).to.throw(InvariantViolation).with.property('oracleNumber', 9);
        });

        it('throws when child references missing parent ID', () => {
            expect(() => {
                InvariantEvaluator.assertSpanContinuity([
                    { id: 'root', name: 'root' },
                    { id: 'orphan', parentId: 'non-existent', name: 'orphan' },
                ]);
            }).to.throw(InvariantViolation).with.property('oracleNumber', 9);
        });
    });

    describe('Oracle 10: assertNoListenerLeak', () => {
        it('passes when listener count matches or is below baseline', () => {
            const emitter = new EventEmitter();
            expect(() => {
                InvariantEvaluator.assertNoListenerLeak(emitter, ['data', 'error'], { data: 0, error: 0 });
            }).to.not.throw();
        });

        it('throws when lingering listeners exceed baseline', () => {
            const emitter = new EventEmitter();
            emitter.on('data', () => {});
            expect(() => {
                InvariantEvaluator.assertNoListenerLeak(emitter, ['data'], { data: 0 });
            }).to.throw(InvariantViolation).with.property('oracleNumber', 10);
        });

        it('throws when baseline count is undefined for an event with listeners', () => {
            const emitter = new EventEmitter();
            emitter.on('ping', () => {});
            expect(() => {
                InvariantEvaluator.assertNoListenerLeak(emitter, ['ping'], {});
            }).to.throw(InvariantViolation).with.property('oracleNumber', 10);
        });
    });
});
