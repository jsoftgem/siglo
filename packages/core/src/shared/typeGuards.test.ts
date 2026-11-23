import { expect } from 'chai';
import { assertNever, getErrorMessage, getErrorName, isFunction, isObject, isPlainObject } from './TypeGuards';

describe('shared.typeGuards.unit.test', () => {
    it('isFunction type guard correctly narrows functions', () => {
        expect(isFunction(() => {})).to.be.true;
        expect(isFunction(function test() {})).to.be.true;
        expect(isFunction(async () => {})).to.be.true;
        expect(isFunction('string')).to.be.false;
        expect(isFunction(123)).to.be.false;
        expect(isFunction(null)).to.be.false;
        expect(isFunction(undefined)).to.be.false;
        expect(isFunction({})).to.be.false;
        expect(isFunction([])).to.be.false;
    });

    it('isObject type guard correctly narrows objects and excludes null', () => {
        expect(isObject({})).to.be.true;
        expect(isObject({ a: 1 })).to.be.true;
        expect(isObject([])).to.be.true;
        expect(isObject(new Date())).to.be.true;
        expect(isObject(null)).to.be.false;
        expect(isObject(undefined)).to.be.false;
        expect(isObject('string')).to.be.false;
        expect(isObject(123)).to.be.false;
        expect(isObject(true)).to.be.false;
        expect(isObject(Symbol('test'))).to.be.false;
    });

    it('isPlainObject excludes arrays, null, and primitives', () => {
        expect(isPlainObject({})).to.be.true;
        expect(isPlainObject({ a: 1 })).to.be.true;
        expect(isPlainObject([])).to.be.false;
        expect(isPlainObject(null)).to.be.false;
        expect(isPlainObject(undefined)).to.be.false;
        expect(isPlainObject('str')).to.be.false;
    });

    it('assertNever throws contextual error', () => {
        expect(() => assertNever('bad' as never)).to.throw('Unexpected value: bad');
        expect(() => assertNever('bad' as never, 'Custom context')).to.throw('Custom context: bad');
    });

    it('getErrorMessage and getErrorName handle Errors, plain objects, and primitives', () => {
        const err = new TypeError('bad input');
        expect(getErrorMessage(err)).to.equal('bad input');
        expect(getErrorName(err)).to.equal('TypeError');

        const emptyErr = new Error('');
        expect(getErrorMessage(emptyErr, 'fallback')).to.equal('fallback');

        expect(getErrorMessage({ message: 'obj msg' })).to.equal('obj msg');
        expect(getErrorMessage({ message: '' }, 'fallback')).to.equal('fallback');
        expect(getErrorName({ name: 'CustomErr' })).to.equal('CustomErr');

        expect(getErrorMessage('string err')).to.equal('string err');
        expect(getErrorMessage(404)).to.equal('404');
        expect(getErrorMessage(null, 'fallback')).to.equal('fallback');
        expect(getErrorMessage(undefined, 'fallback')).to.equal('fallback');
        expect(getErrorMessage(null)).to.equal('Unknown error');

        expect(getErrorName('str')).to.be.undefined;
        expect(getErrorName(null)).to.be.undefined;
        expect(getErrorName({})).to.be.undefined;
        expect(getErrorName({ name: 123 })).to.be.undefined;
    });
});
