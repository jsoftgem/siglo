import { expect } from 'chai';
import {
    Step,
    flow,
    parallel,
    all,
    allSettled,
    race,
    when,
    branch,
    map,
    FieldCollisionException,
    CancellationException,
    clearStorage,
} from '../../index';

describe('Combinators Unit and Concurrency Tests', () => {
    beforeEach(() => {
        clearStorage();
    });

    afterEach(() => {
        clearStorage();
    });

    describe('Parallel Combinator', () => {
        it('executes branches concurrently and preserves timing and branch metadata', async () => {
            const stepA = Step.create('stepA', async () => {
                await new Promise(r => setTimeout(r, 40));
                return { a: 10 };
            });

            const stepB = Step.create('stepB', async () => {
                await new Promise(r => setTimeout(r, 40));
                return { b: 20 };
            });

            const p = parallel(stepA, stepB);
            const start = Date.now();
            const res = await flow(p).execute({}, { pojo: true });
            const elapsed = Date.now() - start;

            // Since they run concurrently in ~40ms, total elapsed should be well under 80ms (e.g. < 70ms)
            expect(elapsed).to.be.below(80);
            expect(res.a).to.equal(10);
            expect(res.b).to.equal(20);
            expect(res.$branches).to.be.an('array');
            expect(res.$branches).to.have.length(2);
            expect(res.$branches[0].status).to.equal('completed');
            expect(res.$branches[1].status).to.equal('completed');
            expect(res.$timing.durationMs).to.be.a('number');
        });

        it('fail-fast aborts sibling branches when one branch fails', async () => {
            let stepBAborted = false;

            const failingStep = Step.create('failingStep', async () => {
                await new Promise(r => setTimeout(r, 15));
                throw new Error('Branch failed rapidly');
            });

            const slowStep = Step.create('slowStep', async (_p: any) => {
                try {
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(resolve, 100);
                        const sig = typeof _p.signal === 'function' ? _p.signal.val || _p.signal() : _p.signal;
                        if (sig) {
                            sig.addEventListener('abort', () => {
                                clearTimeout(timer);
                                stepBAborted = true;
                                reject(new Error('Slow branch aborted'));
                            });
                        }
                    });
                    return { slow: 'finished' };
                } catch (err) {
                    stepBAborted = true;
                    throw err;
                }
            });

            const p = parallel([failingStep, slowStep]);
            try {
                await flow(p).execute();
                expect.fail('Should have failed fast');
            } catch (err: any) {
                expect(err.message).to.equal('Branch failed rapidly');
                expect(stepBAborted).to.be.true;
            }
        });

        it('supports allSettled preserving all results and errors', async () => {
            const stepSuccess = Step.create('ok', () => ({ status: 'ok' }));
            const stepFail = Step.create('bad', () => {
                throw new Error('Boom');
            });

            const p = allSettled([stepSuccess, stepFail]);
            const res = await flow(p).execute({}, { pojo: true });

            expect(res.$branches).to.have.length(2);
            expect(res.$branches[0].status).to.equal('completed');
            expect(res.$branches[1].status).to.equal('failed');
            expect(res.ok).to.deep.equal({ status: 'ok' });
            expect(res.bad.error.message).to.equal('Boom');
        });

        it('supports all combinator (fail-fast alias)', async () => {
            const step1 = Step.create('s1', () => ({ v1: 1 }));
            const step2 = Step.create('s2', () => ({ v2: 2 }));

            const res = await flow(all([step1, step2])).execute({}, { pojo: true });
            expect(res.v1).to.equal(1);
            expect(res.v2).to.equal(2);
        });

        it('race combinator returns the first resolving branch and aborts the loser', async () => {
            let slowAborted = false;

            const fastStep = Step.create('fast', async () => {
                await new Promise(r => setTimeout(r, 10));
                return { winner: 'fast' };
            });

            const slowStep = Step.create('slow', async (p: any) => {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 80);
                    const sig = typeof p.signal === 'function' ? p.signal.val || p.signal() : p.signal;
                    if (sig) {
                        sig.addEventListener('abort', () => {
                            clearTimeout(timer);
                            slowAborted = true;
                            reject(new Error('Slow lost race'));
                        });
                    }
                });
                return { winner: 'slow' };
            });

            const raceStep = race(fastStep, slowStep);
            const res = await flow(raceStep).execute({}, { pojo: true });
            expect(res.winner).to.equal('fast');
            expect(slowAborted).to.be.true;
        });

        it('race combinator rejects when the first resolving branch rejects', async () => {
            const fastFailing = Step.create('fastFail', async () => {
                await new Promise(r => setTimeout(r, 10));
                throw new Error('Fast failed');
            });

            const slowStep = Step.create('slow', async () => {
                await new Promise(r => setTimeout(r, 80));
                return { slow: true };
            });

            try {
                await flow(race([fastFailing, slowStep])).execute();
                expect.fail('Should have rejected');
            } catch (err: any) {
                expect(err.message).to.equal('Fast failed');
            }
        });

        it('supports deep merge strategy and custom merger function', async () => {
            const s1 = Step.create('s1', () => ({
                config: { host: 'localhost', port: 3000 },
            }));
            const s2 = Step.create('s2', () => ({
                config: { port: 8080, secure: true },
            }));

            // Deep merge
            const pDeep = parallel([s1, s2], { mergeStrategy: 'deep' });
            const resDeep = await flow(pDeep).execute({}, { pojo: true });
            expect(resDeep.config.host).to.equal('localhost');
            expect(resDeep.config.port).to.equal(8080);
            expect(resDeep.config.secure).to.equal(true);

            // Custom merger function
            const pCustom = parallel([s1, s2], {
                mergeStrategy: (acc: any, output: any, branchName: any) => {
                    acc[branchName] = output;
                    return acc;
                },
            });
            const resCustom = await flow(pCustom).execute({}, { pojo: true });
            expect(resCustom.s1).to.be.an('object');
            expect(resCustom.s2).to.be.an('object');
        });

        it('detects collisions and throws FieldCollisionException under mergeStrategy: error', async () => {
            const stepA = Step.create('stepA', () => ({
                targetId: 100,
                status: 'pending',
            }));

            const stepB = Step.create('stepB', () => ({
                targetId: 200, // Conflict!
                status: 'pending', // Same value, not a conflict
            }));

            const pError = parallel([stepA, stepB], { mergeStrategy: 'error' });

            try {
                await flow(pError).execute();
                expect.fail('Should have thrown collision exception');
            } catch (err: any) {
                expect(err).to.be.instanceOf(FieldCollisionException);
                expect(err.collisions).to.have.length(1);
                expect(err.collisions[0].field).to.equal('targetId');
            }
        });

        it('supports argument overload variations for parallel and race', async () => {
            const s1 = Step.create('s1', () => ({ v: 1 }));
            const s2 = Step.create('s2', () => ({ v: 2 }));

            // parallel(s1, s2, options)
            const p1 = parallel(s1, s2, { name: 'customPar' });
            expect(p1.name).to.equal('customPar');

            // race(s1, s2, options)
            const r1 = race(s1, s2, { name: 'customRace' });
            expect(r1.name).to.equal('customRace');

            // race([s1, s2])
            const r2 = race([s1, s2]);
            expect(r2.name).to.equal('race');
        });
    });

    describe('Conditions and Branching (when & branch)', () => {
        it('when executes then branch when true and else branch when false', async () => {
            const conditionTrue = when(
                (ctx: any) => ctx.score >= 50,
                Step.create('pass', () => ({ passed: true })),
                Step.create('fail', () => ({ passed: false })),
            );

            const resPass = await flow(conditionTrue).execute({ score: 75 }, { pojo: true });
            expect(resPass.passed).to.be.true;
            expect(resPass.$branchSelected).to.equal('then');
            expect(resPass.$skippedBranches).to.deep.equal(['else']);

            const resFail = await flow(conditionTrue).execute({ score: 30 }, { pojo: true });
            expect(resFail.passed).to.be.false;
            expect(resFail.$branchSelected).to.equal('else');
            expect(resFail.$skippedBranches).to.deep.equal(['then']);
        });

        it('when skips and returns $skipped: true without modifying context when false and no else provided', async () => {
            const conditionNoElse = when(
                (ctx: any) => ctx.hasBonus === true,
                Step.create('addBonus', () => ({ bonus: 500 })),
            );

            const res = await flow(conditionNoElse).execute({ base: 100, hasBonus: false }, { pojo: true });
            expect(res.bonus).to.be.undefined;
            expect(res.$skipped).to.be.true;
            expect(res.$skippedBranches).to.deep.equal(['then']);
        });

        it('branch selects target based on selector function, records skipped branches, and supports default', async () => {
            const multiBranch = branch(
                (ctx: any) => ctx.userType,
                {
                    admin: Step.create('adminStep', () => ({ role: 'administrator', accessLevel: 10 })),
                    member: Step.create('memberStep', () => ({ role: 'member', accessLevel: 1 })),
                },
                Step.create('guestStep', () => ({ role: 'guest', accessLevel: 0 })),
            );

            // 1. Admin
            const resAdmin = await flow(multiBranch).execute({ userType: 'admin' }, { pojo: true });
            expect(resAdmin.role).to.equal('administrator');
            expect(resAdmin.$branchSelected).to.equal('admin');
            expect(resAdmin.$skippedBranches).to.include('member');

            // 2. Member
            const resMember = await flow(multiBranch).execute({ userType: 'member' }, { pojo: true });
            expect(resMember.role).to.equal('member');
            expect(resMember.$branchSelected).to.equal('member');

            // 3. Unknown -> default
            const resGuest = await flow(multiBranch).execute({ userType: 'unknown' }, { pojo: true });
            expect(resGuest.role).to.equal('guest');

            // 4. No default and unknown selector -> skipped
            const branchNoDefault = branch((ctx: any) => ctx.type, {
                known: Step.create('k', () => ({ ok: true })),
            });
            const resSkipped = await flow(branchNoDefault).execute({ type: 'other' }, { pojo: true });
            expect(resSkipped.$skipped).to.be.true;
        });

        it('branch supports object-first syntax inspecting ctx.branch or ctx.status', async () => {
            const objBranch = branch({
                approved: Step.create('app', () => ({ approved: true })),
                declined: Step.create('dec', () => ({ approved: false })),
            });

            const res = await flow(objBranch).execute({ status: 'approved' }, { pojo: true });
            expect(res.approved).to.be.true;
        });
    });

    describe('Mapping and Concurrency Limits (map)', () => {
        it('processes array of items with bounded concurrency and preserves order', async () => {
            let maxConcurrent = 0;
            let active = 0;

            const m = map(
                [1, 2, 3, 4, 5],
                async (item: number) => {
                    active++;
                    if (active > maxConcurrent) maxConcurrent = active;
                    await new Promise(r => setTimeout(r, 20));
                    active--;
                    return item * 10;
                },
                { concurrency: 2, preserveOrder: true },
            );

            const res = await flow(m).execute({}, { pojo: true });
            expect(res.items).to.deep.equal([10, 20, 30, 40, 50]);
            expect(res.count).to.equal(5);
            expect(maxConcurrent).to.be.at.most(2);
        });

        it('streams async iterables through bounded worker pool without unbounded memory', async () => {
            async function* numberGenerator() {
                for (let i = 1; i <= 4; i++) {
                    yield i;
                }
            }

            const m = map(
                () => numberGenerator(),
                async (item: number) => item + 100,
                { concurrency: 2 },
            );

            const res = await flow(m).execute({}, { pojo: true });
            expect(res.items).to.deep.equal([101, 102, 103, 104]);
        });

        it('stopOnError: true fails fast on first item error and aborts in-flight items', async () => {
            const m = map(
                [1, 2, 3, 4],
                async (item: number) => {
                    if (item === 2) {
                        throw new Error('Item 2 failed');
                    }
                    await new Promise(r => setTimeout(r, 40));
                    return item;
                },
                { concurrency: 2, stopOnError: true },
            );

            try {
                await flow(m).execute();
                expect.fail('Should have failed on item 2');
            } catch (err: any) {
                expect(err.message).to.equal('Item 2 failed');
            }
        });

        it('stopOnError: false collects all results and errors', async () => {
            const m = map(
                [1, 2, 3],
                async (item: number) => {
                    if (item === 2) {
                        throw new Error('Error on 2');
                    }
                    return item * 2;
                },
                { stopOnError: false },
            );

            const res = await flow(m).execute({}, { pojo: true });
            expect(res.count).to.equal(3);
            expect(res.items[0]).to.equal(2);
            expect(res.items[1].error.message).to.equal('Error on 2');
            expect(res.items[2]).to.equal(6);
            expect(res.errors).to.have.length(1);
        });

        it('propagates cancellation to map workers', async () => {
            const controller = new AbortController();

            const m = map(
                [1, 2, 3, 4, 5],
                async () => {
                    await new Promise(r => setTimeout(r, 40));
                },
                { concurrency: 2 },
            );

            setTimeout(() => {
                controller.abort(new CancellationException('Map cancelled'));
            }, 15);

            try {
                await flow(m).execute({}, { signal: controller.signal });
                expect.fail('Should have cancelled');
            } catch (err: any) {
                expect(err.isCancellation).to.be.true;
            }
        });

        it('map handles non-iterable items by defaulting to empty array', async () => {
            const m = map(undefined as any, (x: any) => x);
            const res = await flow(m).execute({}, { pojo: true });
            expect(res.items).to.deep.equal([]);
            expect(res.count).to.equal(0);
        });

        it('map supports Step instances and objects with run/execute as processItem', async () => {
            const stepItem = Step.create('procItem', ({ item }: any) => ({ doubled: item * 2 }));
            const m = map([10, 20], stepItem);
            const res = await flow(m).execute({}, { pojo: true });
            expect(res.items).to.deep.equal([{ doubled: 20 }, { doubled: 40 }]);

            const runObj = {
                run: async (inp: any) => ({ fromRun: inp.item + 5 }),
            };
            const mRun = map([1], runObj);
            const resRun = await flow(mRun).execute({}, { pojo: true });
            expect(resRun.items[0]).to.deep.equal({ fromRun: 6 });
        });
    });

    describe('Combinators Edge Cases & Overloads Coverage', () => {
        it('parallel merges primitive branch outputs onto branch names', async () => {
            const s1 = Step.create('numBranch', () => 42);
            const s2 = Step.create('strBranch', () => 'hello');

            const p = parallel(s1, s2);
            const res = await flow(p).execute({}, { pojo: true });
            expect(res.numBranch).to.equal(42);
            expect(res.strBranch).to.equal('hello');
        });

        it('race supports 2-argument array with options overload', async () => {
            const s1 = Step.create('r1', () => ({ winner: 1 }));
            const s2 = Step.create('r2', () => ({ winner: 2 }));
            const r = race([s1, s2], { name: 'twoArgRace' });
            expect(r.name).to.equal('twoArgRace');
            const res = await flow(r).execute({}, { pojo: true });
            expect(res.winner).to.be.oneOf([1, 2]);
        });

        it('when and branch support raw function, run, start, and array targets', async () => {
            const fnTarget = (ctx: any) => ({ fnResult: ctx.v + 1 });
            const w1 = when(() => true, fnTarget);
            const res1 = await flow(w1).execute({ v: 10 }, { pojo: true });
            expect(res1.fnResult).to.equal(11);

            const runTarget = { run: async (inp: any) => ({ runOk: true }) };
            const w2 = when(() => true, runTarget);
            const res2 = await flow(w2).execute({}, { pojo: true });
            expect(res2.runOk).to.be.true;

            const startTarget = { start: async (inp: any) => ({ startOk: true }) };
            const w3 = when(() => true, startTarget);
            const res3 = await flow(w3).execute({}, { pojo: true });
            expect(res3.startOk).to.be.true;

            const sub1 = Step.create('sub1', () => ({ s1: 1 }));
            const sub2 = Step.create('sub2', () => ({ s2: 2 }));
            const w4 = when(() => true, [sub1, sub2]);
            const res4 = await flow(w4).execute({}, { pojo: true });
            expect(res4.s1).to.equal(1);
            expect(res4.s2).to.equal(2);
        });
        it('when and branch handle primitive / null targets in cleanBranchOutput', async () => {
            const wPrimitive = when(
                () => true,
                () => 99,
            );
            const resPrim = await flow(wPrimitive).execute({}, { pojo: true });
            expect(resPrim.value).to.equal(99);

            const bNull = branch(() => 'n', { n: () => null });
            const resNull = await flow(bNull).execute({}, { pojo: true });
            expect(resNull.value).to.be.null;
        });

        it('parallel supports branch objects with run, start, and subflow array', async () => {
            const runBranch = { run: async () => ({ fromRun: 1 }) };
            const startBranch = { start: async () => ({ fromStart: 2 }) };
            const subflowBranch = [Step.create('sub', () => ({ fromSub: 3 }))];

            const p = parallel(runBranch, startBranch, subflowBranch);
            const res = await flow(p).execute({}, { pojo: true });
            expect(res.fromRun).to.equal(1);
            expect(res.fromStart).to.equal(2);
            expect(res.fromSub).to.equal(3);
        });

        it('map supports processItem with start and subflow array', async () => {
            const startItem = { start: async (inp: any) => ({ started: inp.item + 10 }) };
            const mStart = map([1], startItem);
            const resStart = await flow(mStart).execute({}, { pojo: true });
            expect(resStart.items[0]).to.deep.equal({ started: 11 });

            const flowItem = [Step.create('itemStep', (inp: any) => ({ inFlow: inp.item * 3 }))];
            const mFlow = map([2], flowItem);
            const resFlow = await flow(mFlow).execute({}, { pojo: true });
            expect(resFlow.items[0]).to.deep.equal({ inFlow: 6 });
        });
        it('parallel supports function branches and deep merge fallback with primitives', async () => {
            const pFunc = parallel([() => 42], { mergeStrategy: 'deep' });
            const res = await flow(pFunc).execute({}, { pojo: true });
            expect(res.branch_0).to.equal(42);
        });
        it('map processes Step returning primitive and run returning null', async () => {
            const primStep = Step.create('primStep', ({ item }: any) => item * 5);
            const mPrim = map([2, 3], primStep);
            const resPrim = await flow(mPrim).execute({}, { pojo: true });
            expect(resPrim.items).to.deep.equal([10, 15]);

            const nullObj = { run: async () => null };
            const mNull = map([1], nullObj);
            const resNull = await flow(mNull).execute({}, { pojo: true });
            expect(resNull.items).to.deep.equal([null]);
        });

        it('deterministically merges in declaration order even under reverse branch latency', async () => {
            const slowBranch0 = Step.create('branch0', async () => {
                await new Promise(r => setTimeout(r, 25));
                return { count: 1, sharedField: 'fromBranch0' };
            });
            const fastBranch1 = Step.create('branch1', async () => {
                await new Promise(r => setTimeout(r, 5));
                return { count: 2, sharedField: 'fromBranch1' };
            });

            const p = parallel(slowBranch0, fastBranch1);
            const res = await flow(p).execute({}, { pojo: true });

            // Definition order is 0 then 1, so branch1 overwrites branch0
            expect(res.count).to.equal(2);
            expect(res.sharedField).to.equal('fromBranch1');
            expect(res.$branches[0].name).to.equal('branch0');
            expect(res.$branches[1].name).to.equal('branch1');
        });

        it("supports mergeStrategy: 'namespace' placing outputs under branch names", async () => {
            const bA = Step.create('branchA', () => ({ items: [1, 2], val: 'A' }));
            const bB = Step.create('branchB', () => ({ items: [3, 4], val: 'B' }));

            const p = parallel([bA, bB], { mergeStrategy: 'namespace' });
            const res = await flow(p).execute({}, { pojo: true });
            expect(res.branchA).to.deep.equal({ items: [1, 2], val: 'A' });
            expect(res.branchB).to.deep.equal({ items: [3, 4], val: 'B' });
        });

        it('deepMerge concatenates arrays instead of clobbering', async () => {
            const b1 = Step.create('b1', () => ({ data: { tags: ['auth', 'security'] } }));
            const b2 = Step.create('b2', () => ({ data: { tags: ['network', 'audit'] } }));

            const p = parallel([b1, b2], { mergeStrategy: 'deep' });
            const res = await flow(p).execute({}, { pojo: true });
            expect(res.data.tags).to.deep.equal(['auth', 'security', 'network', 'audit']);
        });
    });
});
