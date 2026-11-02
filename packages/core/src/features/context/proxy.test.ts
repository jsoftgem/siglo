import { expect } from 'chai';
import { toPOJO } from './proxy';

describe('proxy.unit.test', () => {
    describe('toPOJO unit tests', () => {
        it('returns primitives and falsy values as-is', () => {
            expect(toPOJO(null)).to.be.null;
            expect(toPOJO(undefined)).to.be.undefined;
            expect(toPOJO(123)).to.equal(123);
            expect(toPOJO('test')).to.equal('test');
        });

        it('returns Date, RegExp, and Error instances as-is', () => {
            const date = new Date();
            const regex = /abc/g;
            const err = new Error('test-err');
            expect(toPOJO(date)).to.equal(date);
            expect(toPOJO(regex)).to.equal(regex);
            expect(toPOJO(err)).to.equal(err);
        });

        it('omits zero-argument functions and methods without invoking them', () => {
            let called = false;
            const input = {
                b: 'text',
                close() {
                    called = true;
                    throw new Error('Closed!');
                },
                destroy: () => {
                    called = true;
                }
            };
            const result = toPOJO<any>(input);
            expect(called).to.be.false;
            expect(result.close).to.be.undefined;
            expect(result.destroy).to.be.undefined;
            expect(result.b).to.equal('text');
            expect(Object.isFrozen(result)).to.be.true;
        });

        it('evaluates functions with _isSigloComputed or .val property and freezes output', () => {
            const computedA = () => 42;
            (computedA as any)._isSigloComputed = true;

            const computedC = () => 100;
            (computedC as any)._isSigloComputed = true;

            const signalGetter = () => 999;
            (signalGetter as any).val = 999;

            const input = {
                a: computedA,
                b: 'text',
                sig: signalGetter,
                nested: {
                    c: computedC
                }
            };
            const result = toPOJO<any>(input);
            expect(result.a).to.equal(42);
            expect(result.b).to.equal('text');
            expect(result.sig).to.equal(999);
            expect(result.nested.c).to.equal(100);
            expect(Object.isFrozen(result)).to.be.true;
            expect(Object.isFrozen(result.nested)).to.be.true;
        });

        it('skips $$$validators and $stackId', () => {
            const input = {
                $$$validators: ['dummy'],
                $stackId: 'internal-stack-id',
                valid: 'yes'
            };
            const result = toPOJO<any>(input);
            expect(result.$$$validators).to.be.undefined;
            expect(result.$stackId).to.be.undefined;
            expect(result.valid).to.equal('yes');
        });

        it('recursively processes arrays with objects, primitives, and freezes array', () => {
            const computedId = () => 1;
            (computedId as any)._isSigloComputed = true;

            const input = {
                items: [
                    { id: computedId },
                    'rawStr',
                    3
                ]
            };
            const result = toPOJO<any>(input);
            expect(result.items[0].id).to.equal(1);
            expect(result.items[1]).to.equal('rawStr');
            expect(Object.isFrozen(result.items)).to.be.true;
        });

        it('preserves promises and event listeners without recursive object traversal', () => {
            const p = Promise.resolve(10);
            const listener = { addEventListener: () => {} };
            const span = { spanContext: () => ({ traceId: '123' }) };
            const input = {
                prom: p,
                eventTarget: listener,
                activeSpan: span
            };
            const result = toPOJO<any>(input);
            expect(result.prom).to.equal(p);
            expect(result.eventTarget).to.equal(listener);
            expect(result.activeSpan).to.equal(span);
        });
    });
});
