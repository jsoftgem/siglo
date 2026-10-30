import { expect } from 'chai';
import { ArrayChain, Executer, Reducer, Runner, Util } from './index';
import Context from '../context';
import OnBefore from './SingleChain/LifeCycle/OnBefore';
import OnFail from './SingleChain/LifeCycle/OnFail';
import OnSkip from './SingleChain/LifeCycle/OnSkip';
import OnAfter from './SingleChain/LifeCycle/OnAfter';
import ResolveChain from './SingleChain/Helpers/ResolveChain';
import StartChain from './SingleChain/StartChain';
describe('executer.unit.test', () => {
    it('Runner returns undefined when chains is undefined', () => {
        const exec = new Executer();
        expect(exec.start({}, undefined)).to.be.undefined;
    });

    it('Util converts object to context structure and returns getData if already context', () => {
        const ctx = Context.createContext('c_1');
        ctx.set('k', 'v');
        expect(Util.convertToContextStructure(ctx, Context, () => 'id', 'test_stack_id').k()).to.equal('v');
        expect(ctx.$stackId).to.equal('test_stack_id');

        const obj = { x: 10 };
        const converted = Util.convertToContextStructure(obj, Context, () => 'id_obj');
        expect(converted.x()).to.equal(10);
    });

    it('Reducer handles promise resolution in action', done => {
        const chain = {
            $chainId: 'r_chain',
            action: (_param: any, current: number) => Promise.resolve(current * 2)
        };
        const reducer = new Reducer(
            [1, 2, 3],
            {},
            chain,
            Context,
            (ctx: any, val: any) => { ctx.set('value', val); }
        );
        reducer.reduce((err, result) => {
            expect(err).to.be.undefined;
            expect(result.value).to.equal(6);
            done();
        });
    });

    it('Reducer handles promise rejection in action', done => {
        const chain = {
            $chainId: 'r_chain_err',
            action: () => Promise.reject(new Error('Reducer promise fail'))
        };
        const reducer = new Reducer(
            [1, 2],
            {},
            chain,
            Context,
            (ctx: any, val: any) => { ctx.set('value', val); }
        );
        reducer.reduce((err) => {
            expect(err.message).to.equal('Reducer promise fail');
            done();
        });
    });

    it('Reducer handles action returning undefined', done => {
        const chain = {
            $chainId: 'r_chain_undef',
            action: () => undefined
        };
        const reducer = new Reducer(
            [1, 2],
            {},
            chain,
            Context,
            (ctx: any, val: any) => { ctx.set('value', val); }
        );
        reducer.reduce((err, result) => {
            expect(err).to.be.undefined;
            expect(result).to.deep.equal({});
            done();
        });
    });

    it('Reducer handles synchronous error in action', done => {
        const chain = {
            $chainId: 'r_chain_throw',
            action: () => { throw new Error('Reducer throw'); }
        };
        const reducer = new Reducer(
            [1],
            {},
            chain,
            Context,
            (ctx: any, val: any) => { ctx.set('value', val); }
        );
        reducer.reduce((err) => {
            expect(err.message).to.equal('Reducer throw');
            done();
        });
    });

    it('OnBefore handles Promise resolving to true', done => {
        const chain = {
            $chainId: 'ob_true',
            onbefore: () => Promise.resolve(true)
        };
        new OnBefore(chain, {}, () => {}, () => {}, Context, () => {
            done();
        });
    });

    it('OnBefore handles Promise resolving to false', done => {
        const chain = {
            $chainId: 'ob_false',
            onbefore: () => Promise.resolve(false)
        };
        new OnBefore(chain, {}, (data) => {
            expect(data).to.be.an('object');
            done();
        }, () => {}, Context, () => {});
    });

    it('OnBefore handles Promise rejecting', done => {
        const chain = {
            $chainId: 'ob_reject',
            onbefore: () => Promise.reject(new Error('OnBefore rejected'))
        };
        new OnBefore(chain, {}, () => {}, (err) => {
            expect(err.message).to.equal('OnBefore rejected');
            done();
        }, Context, () => {});
    });

    it('OnBefore handles synchronous exception', done => {
        const chain = {
            $chainId: 'ob_throw',
            onbefore: () => { throw new Error('OnBefore throw'); }
        };
        new OnBefore(chain, {}, () => {}, (err) => {
            expect(err.message).to.equal('OnBefore throw');
            done();
        }, Context, () => {});
    });

    it('OnBefore handles legacy stackId string as 7th argument', done => {
        const chain = {
            $chainId: 'ob_stack_legacy',
            onbefore: () => false
        };
        new OnBefore(chain, {}, (data) => {
            expect(data).to.be.an('object');
            done();
        }, () => {}, Context, () => {}, 'legacy_stack_id');
    });

    it('OnBefore passes clean POJO param to onbefore', done => {
        let capturedParam: any;
        const chain = {
            $chainId: 'ob_pojo',
            onbefore: (p: any) => {
                capturedParam = p;
                return true;
            }
        };
        new OnBefore(chain, { modernVal: 99 }, () => {}, () => {}, Context, () => {
            expect(capturedParam.modernVal).to.equal(99);
            done();
        });
    });

    describe('OnSkip unit tests', () => {
        it('OnSkip resolves context data when onskip is not a function', done => {
            const chain = { $chainId: 'skip_noop' };
            new OnSkip(chain, {}, (data: any) => {
                expect(data).to.be.an('object');
                done();
            }, () => {}, Context);
        });

        it('OnSkip handles synchronous onskip returning fallback object', done => {
            const chain = {
                $chainId: 'skip_sync',
                onskip: (p: any) => ({ skipped: true, reason: 'test' })
            };
            const propSetter = (ctx: any, ret: any) => {
                for (const k in ret) ctx.set(k, ret[k]);
            };
            new OnSkip(chain, {}, (data: any) => {
                expect(data.skipped).to.be.true;
                expect(data.reason).to.equal('test');
                done();
            }, () => {}, Context, propSetter);
        });

        it('OnSkip handles synchronous onskip returning undefined (side-effect only)', done => {
            let called = false;
            const chain = {
                $chainId: 'skip_undef',
                onskip: () => { called = true; return undefined; }
            };
            new OnSkip(chain, {}, (data: any) => {
                expect(called).to.be.true;
                expect(data).to.be.an('object');
                done();
            }, () => {}, Context);
        });

        it('OnSkip handles synchronous onskip when propertyToContext is omitted', done => {
            const chain = {
                $chainId: 'skip_no_prop',
                onskip: () => ({ some: 'data' })
            };
            new OnSkip(chain, {}, (data: any) => {
                expect(data).to.be.an('object');
                done();
            }, () => {}, Context);
        });

        it('OnSkip catches synchronous throw in onskip', done => {
            const chain = {
                $chainId: 'skip_throw',
                onskip: () => { throw new Error('OnSkip error'); }
            };
            new OnSkip(chain, {}, () => {}, (err: any) => {
                expect(err.message).to.equal('OnSkip error');
                done();
            }, Context);
        });

        it('OnSkip handles promise onskip resolving with fallback object', done => {
            const chain = {
                $chainId: 'skip_async',
                onskip: () => Promise.resolve({ asyncFallback: 100 })
            };
            const propSetter = (ctx: any, ret: any) => {
                for (const k in ret) ctx.set(k, ret[k]);
            };
            new OnSkip(chain, {}, (data: any) => {
                expect(data.asyncFallback).to.equal(100);
                done();
            }, () => {}, Context, propSetter);
        });

        it('OnSkip handles promise onskip resolving with undefined', done => {
            const chain = {
                $chainId: 'skip_async_undef',
                onskip: () => Promise.resolve(undefined)
            };
            new OnSkip(chain, {}, (data: any) => {
                expect(data).to.be.an('object');
                done();
            }, () => {}, Context);
        });

        it('OnSkip catches promise rejection in onskip', done => {
            const chain = {
                $chainId: 'skip_async_rej',
                onskip: () => Promise.reject(new Error('Async skip reject'))
            };
            new OnSkip(chain, {}, () => {}, (err: any) => {
                expect(err.message).to.equal('Async skip reject');
                done();
            }, Context);
        });

        it('OnSkip provides clean POJO param to onskip', done => {
            let received: any;
            const chain = {
                $chainId: 'skip_pojo',
                onskip: (p: any) => {
                    received = p;
                    return { ok: true };
                }
            };
            new OnSkip(chain, { modernKey: 'val' }, () => {
                expect(received.modernKey).to.equal('val');
                done();
            }, () => {}, Context);
        });
    });

    describe('OnAfter unit tests', () => {
        it('OnAfter calls next when onafter is not a function', done => {
            const chain = { $chainId: 'after_noop' };
            new OnAfter(chain, {}, {}, {}, () => {}, () => {
                done();
            }, () => {});
        });

        it('OnAfter handles synchronous onafter returning enrich object', done => {
            const chain = {
                $chainId: 'after_sync',
                onafter: (output: any, param: any) => ({ enriched: output.val + param.add })
            };
            const mockContext: Record<string, any> = {};
            const propSetter = (ctx: any, ret: any) => {
                for (const k in ret) ctx[k] = ret[k];
            };
            new OnAfter(chain, { val: 10 }, { add: 5 }, mockContext, propSetter, () => {
                expect(mockContext.enriched).to.equal(15);
                done();
            }, () => {});
        });

        it('OnAfter handles synchronous onafter returning undefined', done => {
            let sideEffect = false;
            const chain = {
                $chainId: 'after_undef',
                onafter: () => { sideEffect = true; return undefined; }
            };
            new OnAfter(chain, {}, {}, {}, () => {}, () => {
                expect(sideEffect).to.be.true;
                done();
            }, () => {});
        });

        it('OnAfter handles synchronous onafter without propertyToContext', done => {
            const chain = {
                $chainId: 'after_no_prop',
                onafter: () => ({ extra: 'data' })
            };
            new OnAfter(chain, {}, {}, {}, undefined as any, () => {
                done();
            }, () => {});
        });

        it('OnAfter catches synchronous error in onafter', done => {
            const chain = {
                $chainId: 'after_throw',
                onafter: () => { throw new Error('OnAfter throw error'); }
            };
            new OnAfter(chain, {}, {}, {}, () => {}, () => {}, (err: any) => {
                expect(err.message).to.equal('OnAfter throw error');
                done();
            });
        });

        it('OnAfter handles promise onafter resolving with enrich object', done => {
            const chain = {
                $chainId: 'after_async',
                onafter: (output: any) => Promise.resolve({ asyncEnrich: output.total * 2 })
            };
            const mockContext: Record<string, any> = {};
            const propSetter = (ctx: any, ret: any) => {
                for (const k in ret) ctx[k] = ret[k];
            };
            new OnAfter(chain, { total: 50 }, {}, mockContext, propSetter, () => {
                expect(mockContext.asyncEnrich).to.equal(100);
                done();
            }, () => {});
        });

        it('OnAfter handles promise onafter resolving with undefined', done => {
            const chain = {
                $chainId: 'after_async_undef',
                onafter: () => Promise.resolve(undefined)
            };
            new OnAfter(chain, {}, {}, {}, () => {}, () => {
                done();
            }, () => {});
        });

        it('OnAfter catches promise rejection in onafter', done => {
            const chain = {
                $chainId: 'after_async_rej',
                onafter: () => Promise.reject(new Error('Async onafter reject'))
            };
            new OnAfter(chain, {}, {}, {}, () => {}, () => {}, (err: any) => {
                expect(err.message).to.equal('Async onafter reject');
                done();
            });
        });

        it('OnAfter passes clean POJO param to onafter', done => {
            let receivedParam: any;
            const chain = {
                $chainId: 'after_pojo',
                onafter: (_output: any, param: any) => {
                    receivedParam = param;
                    return undefined;
                }
            };
            new OnAfter(chain, {}, { user: 'Alice' }, {}, () => {}, () => {
                expect(receivedParam.user).to.equal('Alice');
                done();
            }, () => {});
        });
    });

    it('OnFail handles retry failure and reject', done => {
        const chain = {
            func: 'failChain',
            onfail: (err: any, retry: () => void, _reject: () => void) => {
                expect(err.func).to.equal('failChain');
                retry();
            }
        };
        const singleChain = {
            start: () => Promise.reject(new Error('Retry failed'))
        };
        new OnFail(
            chain,
            new Error('Init fail'),
            () => {},
            (err) => {
                expect(err.message).to.equal('Retry failed');
                done();
            },
            singleChain,
            {},
            ['failChain'],
            () => {},
            () => {}
        );
    });

    it('OnFail calls reject directly when onfail callback invokes reject', done => {
        const chain = {
            func: 'failChain2',
            onfail: (err: any, _retry: () => void, reject: () => void) => {
                reject();
            }
        };
        new OnFail(
            chain,
            new Error('Direct reject'),
            () => {},
            (err) => {
                expect(err.message).to.equal('Direct reject');
                done();
            },
            {},
            {},
            ['failChain2'],
            () => {},
            () => {}
        );
    });

    
    it("OnFail handles structured retry when chains has no \$chainId", done => {
        let retried = false;
        const chain = {
            func: "namedStep",
            onfail: { maxRetries: 1, delay: 0 }
        };
        const singleChain = {
            start: () => {
                if (!retried) {
                    retried = true;
                    return Promise.resolve({ ok: true });
                }
                return Promise.reject(new Error("fail"));
            }
        };
        new OnFail(
            chain,
            new Error("fail"),
            (val) => {
                expect(val.ok).to.be.true;
                done();
            },
            () => {},
            singleChain,
            {},
            "namedStep",
            () => {},
            () => {}
        );
    });

    it('ResolveChain handles executeAfter rejecting with reject callback', done => {
        new ResolveChain(
            () => {},
            {},
            'rc_chain',
            () => {},
            () => Promise.reject(new Error('ExecuteAfter fail')),
            Context,
            (err) => {
                expect(err.message).to.equal('ExecuteAfter fail');
                done();
            }
        );
    });

    it('ResolveChain handles executeAfter rejecting without reject callback', done => {
        new ResolveChain(
            () => {},
            {},
            'rc_chain',
            (source, data) => {
                expect(source).to.equal('SingleChain');
                if (data.error) {
                    expect(data.error.message).to.equal('ExecuteAfter fail');
                    done();
                }
            },
            () => Promise.reject(new Error('ExecuteAfter fail')),
            Context
        );
    });

    it('ResolveChain handles null context and options.pojo', done => {
        let nullHandled = false;
        new ResolveChain(
            (val) => {
                expect(val).to.be.null;
                nullHandled = true;
            },
            null,
            'null_chain',
            () => {}
        );
        expect(nullHandled).to.be.true;

        new ResolveChain(
            (val) => {
                expect(val.$steps('wrapped_chain').count).to.equal(20);
                expect(val.$steps().wrapped_chain.count).to.equal(20);
            },
            { count: 20 },
            'wrapped_chain',
            () => {},
            undefined,
            Context
        );

        new ResolveChain(
            (val) => {
                expect(val.$steps().step_0).to.be.an('object');
            },
            { count: 5 },
            {}, // anonymous chain
            () => {}
        );

        new ResolveChain(
            (val) => {
                expect(val.count).to.equal(10);
                expect(val.$steps.pojo_chain.count).to.equal(10);
                done();
            },
            { count: 10 },
            'pojo_chain',
            () => {},
            undefined,
            Context,
            undefined,
            { pojo: true }
        );
    });

    it('StartChain executes reducer and catches reducer error', done => {
        const step = {
            func: 'reducerChainTest',
            reducer: 'myList',
            specs: [],
            onbefore: () => true,
            action: () => { throw new Error('Reducer action fail'); }
        };

        const exec = new Executer();
        exec.start({ myList: [1, 2] }, step)!
            .catch((err: any) => {
                expect(err.error.message).to.equal('Reducer action fail');
                done();
            });
    });

    it('StartChain executes reducer with active network policy', done => {
        const step = {
            func: 'reducerNetworkTest',
            reducer: 'myList',
            networkPolicyConfig: { enabled: true, defaultPolicy: 'deny', allowedHosts: ['api.stripe.com'], allowLocalhost: true },
            specs: [],
            onbefore: () => true,
            action: (acc: any, item: any) => {
                return { ...acc, [item]: true };
            }
        };

        const exec = new Executer();
        exec.start({ myList: ['a', 'b'] }, step)!
            .then((res: any) => {
                expect(res.a).to.be.true;
                expect(res.b).to.be.true;
                done();
            })
            .catch(done);
    });

    it('StartChain executes action returning undefined', done => {
        const step = {
            func: 'voidChainTest',
            specs: [],
            onbefore: () => true,
            action: () => undefined
        };

        const exec = new Executer();
        exec.start({}, step)!
            .then(result => {
                expect(result).to.be.an('object');
                done();
            });
    });

    it('StartChain catches action returning rejected promise', done => {
        const step = {
            func: 'asyncFailChainTest',
            specs: [],
            onbefore: () => true,
            action: () => Promise.reject(new Error('Async fail'))
        };

        const exec = new Executer();
        exec.start({}, step)!
            .catch((err: any) => {
                expect(err.error.message).to.equal('Async fail');
                done();
            });
    });

    it('Runner handles single chain rejection properly', done => {
        const step = {
            func: 'throwChainTest',
            specs: [],
            onbefore: () => true,
            action: () => { throw new Error('Sync fail'); }
        };

        const exec = new Executer();
        exec.start({}, step)!
            .catch((err: any) => {
                expect(err.error.message).to.equal('Sync fail');
                done();
            });
    });

    it('Runner handles array chain rejection properly', done => {
        const step = {
            func: 'arrayChainThrowTest',
            specs: [],
            onbefore: () => true,
            action: () => { throw new Error('Array sync fail'); }
        };

        const exec = new Executer();
        exec.start({}, [step])!
            .catch((err: any) => {
                expect(err.error.message).to.equal('Array sync fail');
                done();
            });
    });
    it('Runner handles deleteStack error on single chain success', done => {
        const mockRunner = new Runner(
            () => ({ func: 'mock1', action: () => 'val' }),
            () => 'uuid',
            Context,
            class {
                start = () => Promise.resolve({ ok: true });
            },
            class {},
            class {},
            Util,
            () => 'stack1',
            () => {},
            () => { throw new Error('DeleteStack error'); },
            () => {},
            () => {},
            () => {},
            () => {},
            () => Promise.resolve(),
            () => Promise.resolve()
        );
        mockRunner.start({}, 'mock1')!
            .catch((err: any) => {
                expect(err.message).to.equal('DeleteStack error');
                done();
            });
    });

    it('Runner handles deleteStack error on single chain failure', done => {
        const mockRunner = new Runner(
            () => ({ func: 'mock2' }),
            () => 'uuid',
            Context,
            class {
                start = () => Promise.reject(new Error('SingleChain fail'));
            },
            class {},
            class {},
            Util,
            () => 'stack2',
            () => {},
            () => { throw new Error('DeleteStack on fail error'); },
            () => {},
            () => {},
            () => {},
            () => Promise.resolve(),
            () => Promise.resolve()
        );
        mockRunner.start({}, 'mock2')!
            .catch((err: any) => {
                expect(err.message).to.equal('DeleteStack on fail error');
                done();
            });
    });

    it('Runner handles deleteStack error on array chain success', done => {
        const mockRunner = new Runner(
            () => ({ func: 'mock3' }),
            () => 'uuid',
            Context,
            class {},
            class {
                start = () => Promise.resolve({ ok: true });
            },
            class {},
            Util,
            () => 'stack3',
            () => {},
            () => { throw new Error('DeleteStack array success error'); },
            () => {},
            () => {},
            () => {},
            () => Promise.resolve(),
            () => Promise.resolve()
        );
        mockRunner.start({}, ['mock3'])!
            .catch((err: any) => {
                expect(err.message).to.equal('DeleteStack array success error');
                done();
            });
    });

    it('Runner handles deleteStack error on array chain failure', done => {
        const mockRunner = new Runner(
            () => ({ func: 'mock4' }),
            () => 'uuid',
            Context,
            class {},
            class {
                start = () => Promise.reject(new Error('ArrayChain fail'));
            },
            class {},
            Util,
            () => 'stack4',
            () => {},
            () => { throw new Error('DeleteStack array fail error'); },
            () => {},
            () => {},
            () => {},
            () => Promise.resolve(),
            () => Promise.resolve()
        );
        mockRunner.start({}, ['mock4'])!
            .catch((err: any) => {
                expect(err.message).to.equal('DeleteStack array fail error');
                done();
            });
    });

    it('StartChain handles onfail recovery after action failure', done => {
        let firstRun = true;
        const step = {
            func: 'retryRecoverChain',
            specs: [],
            onbefore: () => true,
            action: () => {
                if (firstRun) {
                    firstRun = false;
                    return Promise.reject(new Error('First run fail'));
                }
                return { status: 'recovered' };
            },
            onfail: (_err: any, retry: () => void) => {
                retry();
            }
        };
        const exec = new Executer();
        exec.start({}, step)!
            .then((result: any) => {
                expect(result.status).to.equal('recovered');
                done();
            })
            .catch(done);
    });

    it('StartChain handles onfail recovery after reducer failure', done => {
        let firstRun = true;
        const step = {
            func: 'reducerRecoverChain',
            reducer: 'myList',
            specs: [],
            onbefore: () => true,
            action: () => {
                if (firstRun) {
                    firstRun = false;
                    throw new Error('Reducer first run fail');
                }
                return { count: 10 };
            },
            onfail: (_err: any, retry: () => void) => {
                retry();
            }
        };
        const exec = new Executer();
        exec.start({ myList: [1] }, step)!
            .then((result: any) => {
                expect(result).to.be.an('object');
                done();
            })
            .catch(done);
    });

    it('StartChain handles onAfter error caught by onfail in standard chain', done => {
        const step = {
            func: 'afterFailChain',
            specs: [],
            onbefore: () => true,
            action: () => ({ val: 42 }),
            onafter: () => { throw new Error('OnAfter standard fail'); },
            onfail: (err: any, _retry: () => void, reject: () => void) => {
                expect(err.message).to.equal('OnAfter standard fail');
                reject();
            }
        };
        const exec = new Executer();
        exec.start({}, step)!
            .catch((err: any) => {
                expect(err.error.message).to.equal('OnAfter standard fail');
                done();
            });
    });

    it('StartChain handles onAfter error and recovery in reducer chain', done => {
        let afterFailed = false;
        const step = {
            func: 'afterReducerFailChain',
            reducer: 'items',
            specs: [],
            onbefore: () => true,
            action: (_param: any, item: number) => ({ sum: item }),
            onafter: () => {
                if (!afterFailed) {
                    afterFailed = true;
                    throw new Error('OnAfter reducer fail');
                }
                return { recovered: true };
            },
            onfail: (_err: any, retry: () => void) => {
                retry();
            }
        };
        const exec = new Executer();
        exec.start({ items: [1] }, step)!
            .then((result: any) => {
                expect(result.sum).to.equal(1);
                expect(result.recovered).to.be.true;
                done();
            })
            .catch(done);
    });

    it('StartChain handles onAfter error without onfail in reducer chain', done => {
        const step = {
            func: 'afterReducerFailChainNoRecovery',
            reducer: 'items',
            specs: [],
            onbefore: () => true,
            action: (_param: any, item: number) => ({ sum: item }),
            onafter: () => Promise.reject(new Error('OnAfter reducer fail no recovery'))
        };
        const exec = new Executer();
        exec.start({ items: [1] }, step)!
            .catch((err: any) => {
                expect(err.error.message).to.equal('OnAfter reducer fail no recovery');
                done();
            });
    });

    it('StartChain handles executeBefore plugin rejecting', done => {
        const startChain = new StartChain(
            () => ({ func: 'ebChain', specs: [], $chainId: 'c_eb' }),
            Context,
            () => {},
            class {},
            () => {},
            'stack_eb',
            () => {},
            () => {},
            () => {},
            () => Promise.resolve(),
            () => Promise.reject(new Error('ExecuteBefore failed'))
        );
        startChain.start({ $chainId: () => 'eb_ctx' }, 'ebChain')
            .catch((err: any) => {
                expect(err.message).to.equal('ExecuteBefore failed');
                done();
            });
    });

    it('StartChain handles synchronous error in try block', done => {
        const startChain = new StartChain(
            () => ({ func: 'syncFail', specs: [], $chainId: 'c_sync' }),
            Context,
            () => {},
            class {},
            () => { throw new Error('addChainToStack sync throw'); },
            'stack_sync',
            () => {},
            () => {},
            () => {},
            () => Promise.resolve(),
            () => Promise.resolve()
        );
        startChain.start({ $chainId: () => 'param_sync' }, 'syncFail')
            .catch((err: any) => {
                expect(err.message).to.equal('addChainToStack sync throw');
                done();
            });
    });

    it("StartChain rejects immediately when options.signal is already aborted", done => {
        const controller = new AbortController();
        controller.abort(new Error("Pre-aborted startChain"));
        const startChain = new StartChain(
            () => ({ func: "abortChain", specs: [], $chainId: "c_abort" }),
            Context,
            () => {},
            class {},
            () => {},
            "stack_abort",
            () => {},
            () => {},
            () => {},
            () => Promise.resolve(),
            () => Promise.resolve()
        );
        startChain.start({ $chainId: () => "param_abort" }, "abortChain", { signal: controller.signal })
            .catch((err: any) => {
                expect(err.message).to.equal("Pre-aborted startChain");
                done();
            });
    });

    it("ArrayChain rejects immediately when options.signal is already aborted", done => {
        const controller = new AbortController();
        controller.abort(new Error("Pre-aborted arrayChain"));
        const arrayChain = new ArrayChain(
            () => {},
            () => "id",
            Context,
            { start: () => Promise.resolve({}) }
        );
        arrayChain.start({}, ["c1"], { signal: controller.signal })
            .catch((err: any) => {
                expect(err.message).to.equal("Pre-aborted arrayChain");
                done();
            });
    });

    it("ArrayChain handles singleChain resolving with null/primitive value", done => {
        const arrayChain = new ArrayChain(
            () => {},
            () => "id",
            Context,
            { start: () => Promise.resolve(null) }
        );
        arrayChain.start({}, ["c_null"]).then(res => {
            expect(res).to.be.null;
            done();
        });
    });
});
