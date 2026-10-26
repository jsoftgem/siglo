import { expect } from 'chai';
import { generateUUID, batch, batchIn, isValidJson, CollectPromiseResult } from './Util';

describe('shared.util.unit.test', () => {
    it('generateUUID generates valid uuid', () => {
        const uuid = generateUUID();
        expect(uuid).to.be.a('string');
        expect(uuid.length).to.equal(36);
        expect(uuid.split('-').length).to.equal(5);
    });

    it('isValidJson validates JSON strings correctly', () => {
        expect(isValidJson('{"valid": true}')).to.be.true;
        expect(isValidJson('{"invalid": true')).to.be.false;
        expect(isValidJson('not json')).to.be.false;
    });

    it('batch processes items in array sequentially', done => {
        const items = [1, 2, 3];
        const processed: number[] = [];
        batch(items, (item, next) => {
            processed.push(item);
            next();
        }, () => {
            expect(processed).to.deep.equal([1, 2, 3]);
            done();
        });
    });

    it('batch handles empty array', done => {
        batch([], (_item, next) => {
            next();
        }, () => {
            done();
        });
    });

    it('batchIn processes object keys and values', done => {
        const obj = { a: 1, b: 2 };
        const processed: number[] = [];
        batchIn(obj, (val, next) => {
            processed.push(val);
            next();
        }, () => {
            expect(processed).to.deep.equal([1, 2]);
            done();
        });
    });

    it('batchIn handles empty object', done => {
        batchIn({}, (_val, next) => {
            next();
        }, () => {
            done();
        });
    });

    it('CollectPromiseResult collects both successes and errors', done => {
        const p1 = Promise.resolve('ok1');
        const p2 = Promise.reject(new Error('fail1'));
        const p3 = Promise.resolve('ok2');
        const p4 = Promise.reject(new Error('fail2'));

        new CollectPromiseResult([p1, p2, p3, p4]).collect((result) => {
            expect(result.success).to.deep.equal(['ok1', 'ok2']);
            expect(result.error.length).to.equal(2);
            expect(result.error[0].message).to.equal('fail1');
            expect(result.error[1].message).to.equal('fail2');
            done();
        });
    });

    it('CollectPromiseResult handles empty array', done => {
        new CollectPromiseResult([]).collect((result) => {
            expect(result.success).to.deep.equal([]);
            expect(result.error).to.deep.equal([]);
            done();
        });
    });
});
