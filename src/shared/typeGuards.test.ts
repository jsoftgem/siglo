import { expect } from 'chai';
import { isFunction, isObject } from './TypeGuards';

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
});
