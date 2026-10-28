import {
    getChainContext,
    getChainDataById,
    getLogMonitor,
    getPlugins,
    putChainContext,
    setChainConfig,
    setGetChainContextPlugin,
    setPutChainContextPlugin,
    createExecutionStack,
    addChainToStack,
    deleteStack,
    cacheChainAction,
    hasCached,
    getCachedChainAction,
    clearCache,
    getStorage,
    clearStorage,
    storage,
    StorageManager,
    serializeParam,
    checkpoint,
    restoreCheckpoint,
    serializeState,
    hydrateState
} from './index';
import { GetChainTypeException } from './get';
import { PutChainTypeException } from './put';
import { expect } from 'chai';

describe('storage.unit.test', () => {
    it('should put chain config', () => {
        setChainConfig({
            logMonitor: () => true,
            plugins: { name: 'sample' }
        });
        expect(getPlugins()).to.be.not.undefined;
        expect(getPlugins().name).to.be.equal('sample');
        expect(getLogMonitor()()).to.be.true;
    });

    it('should put and get chain context in storage', () => {
        putChainContext('chain1', 'user', { name: 'Alice' });
        expect(getChainContext('chain1', 'user')()).to.deep.equal({ name: 'Alice' });
        expect(getChainDataById('chain1').user()).to.deep.equal({ name: 'Alice' });
    });

    it('putChainContext handles nested subfield access', () => {
        putChainContext('chain1_sub', 'profile', { role: 'admin', age: 25 });
        const getter = getChainContext('chain1_sub', 'profile');
        expect(getter('role')).to.equal('admin');
        expect(getter('age')).to.equal(25);
        expect(getter('missing')).to.be.undefined;
    });

    it('manages execution stack lifecycle', () => {
        const stackId = createExecutionStack();
        expect(stackId).to.be.a('string');
        addChainToStack(stackId, 'chain1');
        deleteStack(stackId);
        expect(getChainContext('chain1', 'user')).to.be.undefined;
    });

    it('manages cache operations', () => {
        const stackId = createExecutionStack();
        cacheChainAction(stackId, 'chain1', { id: 1 }, 'result1');
        expect(hasCached(stackId, 'chain1', { id: 1 })).to.be.true;
        expect(hasCached(stackId, 'chain1', { id: 2 })).to.be.false;
        expect(getCachedChainAction(stackId, 'chain1', { id: 1 }).result).to.equal('result1');

        clearCache(stackId, 'chain1');
        expect(hasCached(stackId, 'chain1', { id: 1 })).to.be.false;
        deleteStack(stackId);
    });

    it('getStorage returns frozen snapshot, clearStorage clears', () => {
        createExecutionStack();
        const snapshot = getStorage();
        expect(snapshot).to.be.an('object');
        expect(Object.isFrozen(snapshot)).to.be.true;
        clearStorage();
        expect(getStorage()).to.be.an('object');
    });

    it('plugins can override getChainContext', () => {
        setGetChainContextPlugin((chainId: string, field: string) => {
            return () => `${chainId}_${field}`;
        });
        expect(getChainContext('c1', 'f1')()).to.equal('c1_f1');

        // Reset storage
        clearStorage();
    });

    it('setGetChainContextPlugin throws on non-function', () => {
        expect(() => {
            setGetChainContextPlugin('notAFunction');
        }).to.throw(GetChainTypeException);
    });

    it('putChainContext passes stackId via meta or auto-resolves from stacks', () => {
        let capturedMeta: any;
        setPutChainContextPlugin((_chainId: string, _field: string, _getter: any, meta?: any) => {
            capturedMeta = meta;
        });

        // 1. Explicit meta object
        putChainContext('chainA', 'fieldA', 'valA', { stackId: 'stack_explicit' });
        expect(capturedMeta).to.deep.include({ stackId: 'stack_explicit' });

        // 2. Explicit meta string
        putChainContext('chainB', 'fieldB', 'valB', 'stack_string');
        expect(capturedMeta).to.deep.include({ stackId: 'stack_string' });

        // 3. Auto-resolved stackId from state.stacks
        const autoStackId = createExecutionStack();
        addChainToStack(autoStackId, 'chainC');
        putChainContext('chainC', 'fieldC', 'valC');
        expect(capturedMeta).to.deep.include({ stackId: autoStackId });

        clearStorage();
    });

    it('plugins can override putChainContext', () => {
        let putCtxCalled = false;
        setPutChainContextPlugin((_chainId: string, _field: string, _val: any) => {
            putCtxCalled = true;
        });
        putChainContext('anyId', 'field', 'val');
        expect(putCtxCalled).to.be.true;

        // Reset storage
        clearStorage();
    });

    it('setPutChainContextPlugin throws on non-function', () => {
        expect(() => {
            setPutChainContextPlugin('notAFunction' as any);
        }).to.throw(PutChainTypeException);
    });

    it('storage.__$store throws Unauthorized storage access for invalid id', () => {
        expect(() => {
            storage.__$store('invalid_id');
        }).to.throw('Unauthorized storage access');
    });

    it('serializeParam handles primitives, sorted keys, arrays, circular structures, and errors', () => {
        expect(serializeParam(null)).to.equal('null');
        expect(serializeParam(undefined)).to.equal('undefined');
        expect(serializeParam(42)).to.equal('42');
        expect(serializeParam('hello')).to.equal('"hello"');

        const key1 = serializeParam({ b: 2, a: 1 });
        const key2 = serializeParam({ a: 1, b: 2 });
        expect(key1).to.equal(key2);

        const arrKey = serializeParam([1, { y: 2, x: 1 }]);
        expect(arrKey).to.equal('[1,{"x":1,"y":2}]');

        const circular: any = { name: 'loop' };
        circular.self = circular;
        const circKey = serializeParam(circular);
        expect(circKey).to.include('[Circular]');

        const throwingObj = {
            get bad() {
                throw new Error('fail');
            },
            toString() {
                return 'fallbackString';
            }
        };
        expect(serializeParam(throwingObj)).to.equal('fallbackString');
    });

    it('StorageManager supports isolated instances and edge cases', () => {
        const isolated = new StorageManager();
        expect(isolated.getState()).to.be.an('object');
        expect(isolated.getState().chains.size).to.equal(0);

        isolated.deleteStack('nonexistentStack');

        expect(isolated.getCachedChainAction('noStack', 'noChain', {})).to.be.undefined;
        const stackId = isolated.createExecutionStack();
        isolated.cacheChainAction(stackId, 'otherChain', {}, 'val');
        expect(isolated.getCachedChainAction(stackId, 'noChain', {})).to.be.undefined;

        isolated.clearCache('noStack', 'noChain');
        expect(isolated.hasCached('noStack', 'noChain', {})).to.be.false;

        expect(isolated.getChainContext('noChainId', 'noField')).to.be.undefined;
    });

    describe('Checkpointing and State Serialization unit tests', () => {
        it('checkpoint creates a serializable snapshot of stack execution state', () => {
            const stackId = createExecutionStack();
            addChainToStack(stackId, 'c_step1');
            addChainToStack(stackId, 'c_step2');
            putChainContext('c_step1', 'status', 'started', { stackId });
            putChainContext('c_step2', 'count', 42, { stackId });

            const chk = checkpoint(stackId);
            expect(chk.stackId).to.equal(stackId);
            expect(chk.chains).to.deep.equal(['c_step1', 'c_step2']);
            expect(chk.contexts.c_step1.status).to.equal('started');
            expect(chk.contexts.c_step2.count).to.equal(42);
            expect(chk.timestamp).to.be.a('number');

            clearStorage();
        });

        it('checkpoint throws when stack does not exist', () => {
            expect(() => {
                checkpoint('missing_stack');
            }).to.throw("Execution stack 'missing_stack' not found.");
        });

        it('restoreCheckpoint restores stack and contexts with working getter closures', () => {
            const isolated = new StorageManager();
            const chk = {
                stackId: 'saved_stack',
                type: 'execution',
                chains: ['step_a'],
                contexts: {
                    step_a: {
                        name: 'Rivulet',
                        age: 5
                    }
                },
                timestamp: Date.now()
            };

            isolated.restoreCheckpoint(chk);
            expect(isolated.getChainContext('step_a', 'name')()).to.equal('Rivulet');
            expect(isolated.getChainContext('step_a', 'age')()).to.equal(5);

            clearStorage();
            restoreCheckpoint(chk);
            expect(getChainContext('step_a', 'name')()).to.equal('Rivulet');
            clearStorage();
        });

        it('restoreCheckpoint throws on invalid checkpoint data', () => {
            const isolated = new StorageManager();
            expect(() => {
                isolated.restoreCheckpoint(null as any);
            }).to.throw('Invalid checkpoint data.');
            expect(() => {
                isolated.restoreCheckpoint({} as any);
            }).to.throw('Invalid checkpoint data.');
        });

        it('serializeState serializes single stack when stackId provided', () => {
            const isolated = new StorageManager();
            const stackId = isolated.createExecutionStack();
            isolated.addChainToStack(stackId, 'c_one');
            isolated.putChainContext('c_one', 'token', 'abc123xyz', { stackId });

            const jsonStr = isolated.serializeState(stackId);
            const parsed = JSON.parse(jsonStr);
            expect(parsed.stackId).to.equal(stackId);
            expect(parsed.contexts.c_one.token).to.equal('abc123xyz');
        });

        it('serializeState serializes all stacks, contexts, and config when stackId omitted', () => {
            const isolated = new StorageManager();
            isolated.setChainConfig({ timeout: 5000 });
            const s1 = isolated.createExecutionStack();
            isolated.addChainToStack(s1, 'c_alpha');
            isolated.putChainContext('c_alpha', 'msg', 'hello', { stackId: s1 });

            const jsonStr = isolated.serializeState();
            const parsed = JSON.parse(jsonStr);
            expect(parsed.version).to.equal(1);
            expect(parsed.config.timeout).to.equal(5000);
            expect(parsed.stacks[s1]).to.be.an('object');
            expect(parsed.contexts.c_alpha.msg).to.equal('hello');
        });

        it('hydrateState restores from full serialized JSON string', () => {
            const isolated = new StorageManager();
            const serialized = JSON.stringify({
                version: 1,
                timestamp: Date.now(),
                config: { env: 'production' },
                stacks: {
                    stack_hydrated: {
                        type: 'execution',
                        chains: ['chain_h1']
                    }
                },
                contexts: {
                    chain_h1: {
                        value: 999
                    }
                }
            });

            isolated.hydrateState(serialized);
            expect(isolated.getChainContext('chain_h1', 'value')()).to.equal(999);
        });

        it('hydrateState restores from checkpoint object directly', () => {
            const isolated = new StorageManager();
            isolated.hydrateState({
                stackId: 'direct_chk',
                type: 'execution',
                chains: ['ch_1'],
                contexts: {
                    ch_1: { result: 'ok' }
                },
                timestamp: Date.now()
            });
            expect(isolated.getChainContext('ch_1', 'result')()).to.equal('ok');
        });

        it('hydrateState throws when serialized input is empty', () => {
            const isolated = new StorageManager();
            expect(() => {
                isolated.hydrateState(null as any);
            }).to.throw('Cannot hydrate empty state.');
        });

        it('defaultStorageManager export functions serializeState and hydrateState work globally', () => {
            clearStorage();
            const sId = createExecutionStack();
            addChainToStack(sId, 'globalChain');
            putChainContext('globalChain', 'flag', true, { stackId: sId });

            const serialized = serializeState(sId);
            clearStorage();
            expect(getChainContext('globalChain', 'flag')).to.be.undefined;

            hydrateState(serialized);
            expect(getChainContext('globalChain', 'flag')()).to.be.true;
            clearStorage();
        });
    });
});
