import { expect } from 'chai';
import { wrapParam, toPOJO } from './proxy';

describe('proxy.unit.test', () => {
    it('returns falsy or non-object values as is', () => {
        expect(wrapParam(null as any)).to.be.null;
        expect(wrapParam(undefined as any)).to.be.undefined;
        expect(wrapParam('string' as any)).to.equal('string');
        expect(wrapParam(42 as any)).to.equal(42);
    });

    it('returns already wrapped object without re-wrapping', () => {
        const obj = {
            foo: () => 'bar'
        };
        const wrapped1 = wrapParam(obj);
        const wrapped2 = wrapParam(wrapped1);
        expect(wrapped1).to.equal(wrapped2);
    });

    it('handles symbol property access', () => {
        const sym = Symbol('test');
        const obj = {
            [sym]: 'symbol-value',
            val: () => 10
        };
        const wrapped = wrapParam(obj);
        // @ts-expect-error symbol index signature
        expect(wrapped[sym]).to.equal('symbol-value');
    });

    it('returns undefined for non-existent properties and preserves Object.prototype', () => {
        const obj = {
            val: () => 10
        };
        const wrapped = wrapParam(obj);
        expect(wrapped.doesNotExist).to.be.undefined;
        expect(wrapped.hasOwnProperty).to.be.a('function');
        expect(wrapped.toString).to.be.a('function');
    });

    it('supports toJSON returning rawProps', () => {
        const obj = {
            a: () => 1,
            b: 2
        };
        const wrapped = wrapParam(obj);
        expect(wrapped.toJSON()).to.deep.equal({ a: 1, b: 2 });
    });

    it('supports coercion to number and string templates', () => {
        const obj = {
            num: () => 42,
            str: () => 'hello'
        };
        const wrapped = wrapParam(obj);
        expect(+wrapped.num).to.equal(42);
        expect(Number(wrapped.num)).to.equal(42);
        expect(`${wrapped.str}`).to.equal('hello');
        expect(String(wrapped.str)).to.equal('hello');
    });

    it('supports nested objects in accessor', () => {
        const obj = {
            user: () => ({ name: 'John', age: 30 })
        };
        const wrapped = wrapParam(obj);
        expect(wrapped.user.name).to.equal('John');
        expect(wrapped.user.age).to.equal(30);
    });

    it('handles null rawVal gracefully without defining properties', () => {
        const obj = {
            empty: () => null
        };
        const wrapped = wrapParam(obj);
        expect(wrapped.empty()).to.be.null;
    });

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

        it('skips $$$validators and handles getter throwing an exception', () => {
            const throwingFn = () => { throw new Error('getter err'); };
            const input = {
                $$$validators: ['dummy'],
                bad: throwingFn
            };
            const result = toPOJO<any>(input);
            expect(result.$$$validators).to.be.undefined;
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

        it("supports subfield accessor calling, Object.keys, and getOwnPropertyDescriptor on wrapped", () => {
            const wrapped = wrapParam({ profile: () => ({ role: "admin" }) });
            expect(wrapped.profile("role")).to.equal("admin");
            expect(Object.keys(wrapped)).to.include("profile");
            const desc = Object.getOwnPropertyDescriptor(wrapped, "profile");
            expect(desc).to.not.be.undefined;
        });
        it('supports in operator has trap and non-configurable non-writable properties', () => {
            const target: any = { role: "admin" };
            Object.defineProperty(target, "frozen", {
                value: 42,
                writable: false,
                configurable: false,
                enumerable: true
            });
            const wrapped = wrapParam(target);
            expect("role" in wrapped).to.be.true;
            expect("missing" in wrapped).to.be.false;
            expect(wrapped.frozen).to.equal(42);
        });
    });
});
