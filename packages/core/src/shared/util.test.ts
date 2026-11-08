import { expect } from 'chai';
import { generateUUID, batch, batchIn, isValidJson, CollectPromiseResult, safeClone } from './Util';

describe('shared.util.unit.test', () => {
    it('preserves AbortSignal identity and cancellation listeners when cloning context', () => {
        const controller = new AbortController();
        const cloned = safeClone({ signal: controller.signal, data: { value: 1 } });
        expect(cloned.signal).to.equal(controller.signal);
        controller.abort('cancelled');
        expect(cloned.signal.aborted).to.equal(true);
        expect(cloned.signal.reason).to.equal('cancelled');
        expect(cloned.data).to.deep.equal({ value: 1 });
    });

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
        batch(
            items,
            (item, next) => {
                processed.push(item);
                next();
            },
            () => {
                expect(processed).to.deep.equal([1, 2, 3]);
                done();
            },
        );
    });

    it('batch handles empty array', done => {
        batch(
            [],
            (_item, next) => {
                next();
            },
            () => {
                done();
            },
        );
    });

    it('batchIn processes object keys and values', done => {
        const obj = { a: 1, b: 2 };
        const processed: number[] = [];
        batchIn(
            obj,
            (val, next) => {
                processed.push(val);
                next();
            },
            () => {
                expect(processed).to.deep.equal([1, 2]);
                done();
            },
        );
    });

    it('batchIn handles empty object', done => {
        batchIn(
            {},
            (_val, next) => {
                next();
            },
            () => {
                done();
            },
        );
    });

    it('CollectPromiseResult collects both successes and errors', done => {
        const p1 = Promise.resolve('ok1');
        const p2 = Promise.reject(new Error('fail1'));
        const p3 = Promise.resolve('ok2');
        const p4 = Promise.reject(new Error('fail2'));

        new CollectPromiseResult([p1, p2, p3, p4]).collect(result => {
            expect(result.success).to.deep.equal(['ok1', 'ok2']);
            expect(result.error.length).to.equal(2);
            expect(result.error[0].message).to.equal('fail1');
            expect(result.error[1].message).to.equal('fail2');
            done();
        });
    });

    it('CollectPromiseResult handles empty array', done => {
        new CollectPromiseResult([]).collect(result => {
            expect(result.success).to.deep.equal([]);
            expect(result.error).to.deep.equal([]);
            done();
        });
    });

    it('safeClone handles primitives, dates, regexps, errors, buffers, maps, sets, arrays, objects, and circular refs', () => {
        expect(safeClone(null)).to.equal(null);
        expect(safeClone(123)).to.equal(123);
        expect(safeClone('hello')).to.equal('hello');
        expect(safeClone(true)).to.equal(true);

        const d = new Date(1700000000000);
        const clonedD = safeClone(d);
        expect(clonedD).to.be.instanceOf(Date);
        expect(clonedD.getTime()).to.equal(d.getTime());

        const r = /abc/gi;
        const clonedR = safeClone(r);
        expect(clonedR).to.be.instanceOf(RegExp);
        expect(clonedR.source).to.equal('abc');
        expect(clonedR.flags).to.equal('gi');

        const err = new Error('boom');
        expect(safeClone(err)).to.equal(err);

        const buf = new Uint8Array([1, 2, 3]);
        expect(safeClone(buf)).to.equal(buf);

        const map = new Map<string, any>([['k', { v: 1 }]]);
        const clonedMap = safeClone(map);
        expect(clonedMap.get('k')).to.deep.equal({ v: 1 });
        expect(clonedMap.get('k')).to.not.equal(map.get('k'));

        const set = new Set([{ v: 2 }]);
        const clonedSet = safeClone(set);
        expect(Array.from(clonedSet)[0]).to.deep.equal({ v: 2 });
        expect(Array.from(clonedSet)[0]).to.not.equal(Array.from(set)[0]);

        const arr = [{ a: 1 }, [2]];
        const clonedArr = safeClone(arr);
        expect(clonedArr).to.deep.equal(arr);
        expect(clonedArr).to.not.equal(arr);

        const circular: any = { name: 'circ' };
        circular.self = circular;
        const clonedCirc = safeClone(circular);
        expect(clonedCirc.name).to.equal('circ');
        expect(clonedCirc.self).to.equal(clonedCirc);
    });
});
