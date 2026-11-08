import { getPlugins as plugins, setChainConfig } from '../storage';

import { getLogger } from './getLogger';
import { getPlugins } from './getPlugins';

export default class Configurator {
    static configure(props: Record<string, any>): void {
        const config: Record<string, any> = {};
        getLogger(config, props);
        getPlugins(config, props, plugins());
        setChainConfig(config);
    }
    /* c8 ignore next */
}

export { Configurator };
