import { expect } from 'chai';
import { getPlugins } from './getPlugins';
import { getLogger } from './getLogger';
import Configurator from './index';

describe('configurator.unit.test', () => {

    it('throws an error when plugin is missing .name', () => {
        expect(() => {
            getPlugins({}, {
                plugins: [{}]
            });
        }).to.throw('plugin must have .name');
    });

    it('throw error when plugin is missing action', () => {
        expect(() => {
            getPlugins({}, {
                plugins: [{
                    name: 'Sample'
                }]
            });
        }).to.throw('plugin must have .action function');
    });

    it('throw error when plugin is missing before or after chains', () => {
        expect(() => {
            getPlugins({}, {
                plugins: [{
                    name: 'Sample',
                    action: () => { }
                }]
            });
        }).to.throw('plugin must have alteast one .before or .after array');
    });

    it('throw error when plugins is not an array', () => {
        expect(() => {
            getPlugins({}, {
                plugins: 'invalid' as any
            });
        }).to.throw('plugins must be array');
    });

    it('throw error when plugin.before is not an array', () => {
        expect(() => {
            getPlugins({}, {
                plugins: [{
                    name: 'Sample',
                    action: () => {},
                    before: 'notAnArray' as any
                }]
            });
        }).to.throw('plugin.before must be array');
    });

    it('throw error when plugin.after is not an array', () => {
        expect(() => {
            getPlugins({}, {
                plugins: [{
                    name: 'Sample',
                    action: () => {},
                    after: 'notAnArray' as any
                }]
            });
        }).to.throw('plugin.after must be array');
    });

    it('should create before chain plugins', () => {
        const config: any = {};
        let counter = 0;
        getPlugins(config, {
            plugins: [{
                name: 'Sample',
                action: () => {
                    counter++;
                },
                before: ['chain1', 'chain2', 'chain3']
            }]
        });
        expect(config.plugins).to.be.not.undefined;
        Object.keys(config.plugins).filter(key => key.indexOf('before') > -1).forEach(key => {
            config.plugins[key][0].action();
        });
        expect(counter).to.be.equal(3);
    });

    it('should create after chain plugins', () => {
        const config: any = {};
        let counter = 0;
        getPlugins(config, {
            plugins: [{
                name: 'Sample',
                action: () => {
                    counter++;
                },
                after: ['chain1', 'chain2', 'chain3']
            }]
        });
        expect(config.plugins).to.be.not.undefined;
        Object.keys(config.plugins).filter(key => key.indexOf('after') > -1).forEach(key => {
            config.plugins[key][0].action();
        });
        expect(counter).to.be.equal(3);
    });

    it('should extends existing plugins', () => {
        const config: any = {};
        const plugins: any = {
            'before_everything': [{
                name: 'sample',
                action: () => { }
            }]
        };
        getPlugins(config, {
            plugins: [{
                name: 'sample',
                action: () => { },
                before: ['everything', 'everything2'],
                after: ['everything']
            }, {
                name: 'sample2',
                action: () => { },
                before: ['everything']
            }]
        }, plugins);
        expect(config.plugins.after_everything).to.be.not.undefined;
        expect(config.plugins.before_everything).to.be.not.undefined;
        expect(config.plugins.before_everything2).to.be.not.undefined;

        expect(config.plugins.after_everything.length).to.be.equal(1);
        expect(config.plugins.before_everything.length).to.be.equal(3);
        expect(config.plugins.before_everything2.length).to.be.equal(1);
    });

    it('getLogger sets default logMonitor if not provided', () => {
        const config: any = {};
        getLogger(config, {});
        expect(config.logMonitor).to.be.a('function');
        expect(config.logMonitor()).to.be.false;
    });

    it('getLogger throws error if logMonitor is not a function', () => {
        const config: any = {};
        expect(() => {
            getLogger(config, { logMonitor: 'notAFunction' });
        }).to.throw('logMonitor must be a Function');
    });

    it('getLogger sets logMonitor when provided correctly', () => {
        const config: any = {};
        const fn = () => true;
        getLogger(config, { logMonitor: fn });
        expect(config.logMonitor).to.equal(fn);
    });

    it('Configurator.configure works with empty or full props', () => {
        Configurator.configure({});
        Configurator.configure({
            logMonitor: () => {},
            plugins: [
                {
                    name: 'PluginX',
                    action: () => 'result',
                    before: ['target1']
                }
            ]
        });
        expect(new Configurator()).to.be.an.instanceOf(Configurator);
    });

});
