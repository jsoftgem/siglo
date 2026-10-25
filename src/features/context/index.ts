import { getChainContext, getChainDataById, putChainContext } from '../storage';

import { CollectPromiseResult, CHAIN_ID, STACK_ID, NAMESPACE } from '../../shared';
import { GetContext } from './get';
import { Validators } from './validators';
import { setContextValue } from './set';
import { toPOJO, wrapParam } from './proxy';

export default class Context {
    $chainId: string;
    $stackId?: string;
    $namespace?: string;

    constructor($chainId: string, $stackId?: string, $namespace?: string) {
        this.$chainId = $chainId;
        this.$stackId = $stackId;
        this.$namespace = $namespace;
    }

    set(name: string, value: any): void {
        const meta: Record<string, any> = {};
        if (this.$stackId) {
            meta.stackId = this.$stackId;
        }
        if (this.$namespace) {
            meta.namespace = this.$namespace;
        }
        setContextValue(putChainContext, this.$chainId, name, value, Object.keys(meta).length ? meta : undefined);
    }

    setStackId(stackId: string): void {
        this.$stackId = stackId;
        this.set(STACK_ID, stackId);
    }

    setNamespace(namespace: string): void {
        this.$namespace = namespace;
        this.set(NAMESPACE, namespace);
    }

    addSpec(fieldSpec: any): void {
        new Validators(this.$chainId, getChainContext.bind(this))
            .addSpec(fieldSpec, this.set.bind(this));
    }

    getData(): Record<string, any> {
        return new GetContext(this.$chainId, getChainDataById.bind(this)).getContext();
    }

    validate(): Promise<void> {
        return new Validators(this.$chainId, getChainContext.bind(this), CollectPromiseResult).runValidations(this);
    }

    runSpecs(): Promise<void> {
        return new Validators(this.$chainId, getChainContext.bind(this), CollectPromiseResult).runSpecs(this);
    }

    static createContext(chainId: string, stackId?: string, namespace?: string): Context {
        const context = new Context(chainId, stackId, namespace);
        context.set(CHAIN_ID, chainId);
        if (stackId) {
            context.set(STACK_ID, stackId);
        }
        if (namespace) {
            context.set(NAMESPACE, namespace);
        }
        return context;
    }
/* c8 ignore next */
}

export { Context, toPOJO, wrapParam };
