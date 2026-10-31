import { getChainContext, getChainDataById, putChainContext } from '../storage';

import { CollectPromiseResult, STEP_ID, STACK_ID, NAMESPACE } from '../../shared';
import { GetContext } from './get';
import { Validators } from './validators';
import { setContextValue } from './set';
import { toPOJO } from './proxy';

export default class Context {
    $stepId: string;
    $stackId?: string;
    $namespace?: string;

    constructor($stepId: string, $stackId?: string, $namespace?: string) {
        this.$stepId = $stepId;
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
        setContextValue(putChainContext, this.$stepId, name, value, Object.keys(meta).length ? meta : undefined);
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
        new Validators(this.$stepId, getChainContext.bind(this))
            .addSpec(fieldSpec, this.set.bind(this));
    }

    getData(): Record<string, any> {
        return new GetContext(this.$stepId, getChainDataById.bind(this)).getContext();
    }

    validate(): Promise<void> {
        return new Validators(this.$stepId, getChainContext.bind(this), CollectPromiseResult).runValidations(this);
    }

    runSpecs(): Promise<void> {
        return new Validators(this.$stepId, getChainContext.bind(this), CollectPromiseResult).runSpecs(this);
    }

    static createContext(stepId: string, stackId?: string, namespace?: string): Context {
        const context = new Context(stepId, stackId, namespace);
        context.set(STEP_ID, stepId);
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

export { Context, toPOJO };
