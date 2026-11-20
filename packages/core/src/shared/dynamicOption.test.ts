import { expect } from 'chai';
import { parseDuration, resolveDynamic } from './DynamicOption';

describe('shared.dynamicOption.unit.test', () => {
    describe('resolveDynamic', () => {
        it('returns static values as-is', () => {
            expect(resolveDynamic('static', { id: 1 })).to.equal('static');
            expect(resolveDynamic(42, { id: 1 })).to.equal(42);
            expect(resolveDynamic({ a: true }, { id: 1 })).to.deep.equal({ a: true });
        });

        it('invokes synchronous function resolvers with context', () => {
            const ctx = { tenant: 'acme', ttl: '5m' };
            expect(resolveDynamic(c => `key:${c.tenant}`, ctx)).to.equal('key:acme');
            expect(resolveDynamic(c => c.ttl, ctx)).to.equal('5m');
        });
    });

    describe('parseDuration', () => {
        it('returns undefined for undefined and null', () => {
            expect(parseDuration(undefined)).to.be.undefined;
            expect(parseDuration(null)).to.be.undefined;
        });

        it('preserves finite numbers as milliseconds and rejects non-finite numbers', () => {
            expect(parseDuration(0)).to.equal(0);
            expect(parseDuration(1234)).to.equal(1234);
            expect(parseDuration(-50)).to.equal(-50);
            expect(parseDuration(Number.NaN)).to.be.undefined;
            expect(parseDuration(Number.POSITIVE_INFINITY)).to.be.undefined;
        });

        it('parses duration strings with units and decimal values', () => {
            expect(parseDuration('500ms')).to.equal(500);
            expect(parseDuration('30s')).to.equal(30000);
            expect(parseDuration('5m')).to.equal(300000);
            expect(parseDuration('2h')).to.equal(7200000);
            expect(parseDuration('1d')).to.equal(86400000);
            expect(parseDuration('1.5s')).to.equal(1500);
            expect(parseDuration(' 10 S ')).to.equal(10000);
        });

        it('parses numeric strings and handles empty or invalid strings safely', () => {
            expect(parseDuration('250')).to.equal(250);
            expect(parseDuration('1e3')).to.equal(1000);
            expect(parseDuration('-100')).to.equal(-100);
            expect(parseDuration('')).to.be.undefined;
            expect(parseDuration('   ')).to.be.undefined;
            expect(parseDuration('invalid')).to.be.undefined;
        });
    });
});
