import { executeAfter, executeBefore, executeBeforePlugins, executeAfterPlugins } from './index';
import Configurator from '../configurator';
import Context from '../context';
import { expect } from 'chai';

describe('plugin.unit.test', () => {
    it('should resolve even before is missing', done => {
        executeBefore('chain1', {}).then(() => {
            done();
        });
    });

    it('should resolve even after is missing', done => {
        executeAfter('chain1', {}).then(() => {
            done();
        });
    });

    it('should run before plugins', done => {
        Configurator.configure({
            plugins: [
                {
                    name: 'samplePlugin',
                    action: () => ({
                        hello: 'world!',
                    }),
                    before: ['chain1'],
                },
                {
                    name: 'samplePlugin2',
                    action: () =>
                        new Promise(resolve => {
                            resolve({ hi: 'hello!' });
                        }),
                    before: ['chain1'],
                },
                {
                    name: 'samplePlugin3',
                    action: () => 'sample3',
                    before: ['chain1'],
                },
                {
                    name: 'samplePluginVoid',
                    action: () => undefined,
                    before: ['chain1'],
                },
            ],
        });
        const ctx = new Context('chain1');
        executeBefore('chain1', ctx).then((resolve: any) => {
            expect(resolve.samplePlugin.hello).to.be.equal('world!');
            expect(resolve.samplePlugin2.hi).to.be.equal('hello!');
            expect(resolve.samplePlugin3).to.be.equal('sample3');
            expect(resolve.samplePluginVoid).to.be.undefined;
            done();
        });
    });

    it('should run after plugins', done => {
        Configurator.configure({
            plugins: [
                {
                    name: 'samplePlugin',
                    action: () => ({
                        hello: 'world!',
                    }),
                    after: ['chain1'],
                },
                {
                    name: 'samplePlugin2',
                    action: () =>
                        new Promise(resolve => {
                            resolve({ hi: 'hello!' });
                        }),
                    after: ['chain1'],
                },
                {
                    name: 'samplePlugin3',
                    action: () => 'sample3',
                    after: ['chain1'],
                },
                {
                    name: 'samplePluginVoid',
                    action: () => undefined,
                    after: ['chain1'],
                },
            ],
        });
        const ctx = new Context('chain1');
        executeAfter('chain1', ctx).then((resolve: any) => {
            expect(resolve.samplePlugin.hello).to.be.equal('world!');
            expect(resolve.samplePlugin2.hi).to.be.equal('hello!');
            expect(resolve.samplePlugin3).to.be.equal('sample3');
            expect(resolve.samplePluginVoid).to.be.undefined;
            done();
        });
    });

    it('handles synchronous error in before plugin action', done => {
        const plugins = {
            before_errChain: [
                {
                    name: 'errPlugin',
                    action: () => {
                        throw new Error('sync error');
                    },
                },
            ],
        };
        executeBeforePlugins('errChain', {}, plugins).catch(err => {
            expect(err.message).to.equal('sync error');
            done();
        });
    });

    it('handles promise rejection in before plugin action', done => {
        const plugins = {
            before_errChainAsync: [
                {
                    name: 'errPluginAsync',
                    action: () => Promise.reject(new Error('async error')),
                },
            ],
        };
        executeBeforePlugins('errChainAsync', {}, plugins).catch(err => {
            expect(err.message).to.equal('async error');
            done();
        });
    });

    it('handles synchronous error in after plugin action', done => {
        const plugins = {
            after_errChain: [
                {
                    name: 'errPlugin',
                    action: () => {
                        throw new Error('sync after error');
                    },
                },
            ],
        };
        executeAfterPlugins('errChain', {}, plugins).catch(err => {
            expect(err.message).to.equal('sync after error');
            done();
        });
    });

    it('handles promise rejection in after plugin action', done => {
        const plugins = {
            after_errChainAsync: [
                {
                    name: 'errPluginAsync',
                    action: () => Promise.reject(new Error('async after error')),
                },
            ],
        };
        executeAfterPlugins('errChainAsync', {}, plugins).catch(err => {
            expect(err.message).to.equal('async after error');
            done();
        });
    });
});
