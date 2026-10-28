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

        it('converts function getters to values and freezes output', () => {
            const input = {
                a: () => 42,
                b: 'text',
                nested: {
                    c: () => 100
                }
            };
            const result = toPOJO<any>(input);
            expect(result.a).to.equal(42);
            expect(result.b).to.equal('text');
            expect(result.nested.c).to.equal(100);
            expect(Object.isFrozen(result)).to.be.true;
            expect(Object.isFrozen(result.nested)).to.be.true;
        });

        it('skips $$$validators and $stackId, and handles getter throwing an exception', () => {
            const throwingFn = () => { throw new Error('getter err'); };
            const input = {
                $$$validators: ['dummy'],
                $stackId: 'internal-stack-id',
                bad: throwingFn
            };
            const result = toPOJO<any>(input);
            expect(result.$$$validators).to.be.undefined;
            expect(result.$stackId).to.be.undefined;
            expect(result.bad).to.equal(throwingFn);
        });

        it('recursively processes arrays with objects, primitives, and freezes array', () => {
            const input = {
                items: [
                    { id: () => 1 },
                    'rawStr',
                    3
                ]
            };
            const result = toPOJO<any>(input);
            expect(result.items[0].id).to.equal(1);
            expect(result.items[1]).to.equal('rawStr');
            expect(Object.isFrozen(result.items)).to.be.true;
        });

        it('preserves promises, getters, and event listeners without recursive object traversal', () => {
            const p = Promise.resolve(10);
            const getter = () => 'calculatedVal';
            const listener = { addEventListener: () => {} };
            const input = {
                prom: p,
                computed: getter,
                eventTarget: listener
            };
            const result = toPOJO<any>(input);
            expect(result.prom).to.equal(p);
            expect(result.computed).to.equal('calculatedVal');
            expect(result.eventTarget).to.equal(listener);
        });
    });
});
