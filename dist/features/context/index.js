"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapParam = exports.toPOJO = exports.Context = void 0;
const storage_1 = require("../storage");
const shared_1 = require("../../shared");
const get_1 = require("./get");
const validators_1 = require("./validators");
const set_1 = require("./set");
const proxy_1 = require("./proxy");
Object.defineProperty(exports, "toPOJO", { enumerable: true, get: function () { return proxy_1.toPOJO; } });
Object.defineProperty(exports, "wrapParam", { enumerable: true, get: function () { return proxy_1.wrapParam; } });
class Context {
    $chainId;
    $stackId;
    $namespace;
    constructor($chainId, $stackId, $namespace) {
        this.$chainId = $chainId;
        this.$stackId = $stackId;
        this.$namespace = $namespace;
    }
    set(name, value) {
        const meta = {};
        if (this.$stackId) {
            meta.stackId = this.$stackId;
        }
        if (this.$namespace) {
            meta.namespace = this.$namespace;
        }
        (0, set_1.setContextValue)(storage_1.putChainContext, this.$chainId, name, value, Object.keys(meta).length ? meta : undefined);
    }
    setStackId(stackId) {
        this.$stackId = stackId;
        this.set(shared_1.STACK_ID, stackId);
    }
    setNamespace(namespace) {
        this.$namespace = namespace;
        this.set(shared_1.NAMESPACE, namespace);
    }
    addSpec(fieldSpec) {
        new validators_1.Validators(this.$chainId, storage_1.getChainContext.bind(this))
            .addSpec(fieldSpec, this.set.bind(this));
    }
    getData() {
        return new get_1.GetContext(this.$chainId, storage_1.getChainDataById.bind(this)).getContext();
    }
    validate() {
        return new validators_1.Validators(this.$chainId, storage_1.getChainContext.bind(this), shared_1.CollectPromiseResult).runValidations(this);
    }
    runSpecs() {
        return new validators_1.Validators(this.$chainId, storage_1.getChainContext.bind(this), shared_1.CollectPromiseResult).runSpecs(this);
    }
    static createContext(chainId, stackId, namespace) {
        const context = new Context(chainId, stackId, namespace);
        context.set(shared_1.CHAIN_ID, chainId);
        if (stackId) {
            context.set(shared_1.STACK_ID, stackId);
        }
        if (namespace) {
            context.set(shared_1.NAMESPACE, namespace);
        }
        return context;
    }
}
exports.default = Context;
exports.Context = Context;
//# sourceMappingURL=index.js.map