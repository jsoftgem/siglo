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
    $tenantId;
    constructor($chainId, $stackId, $tenantId) {
        this.$chainId = $chainId;
        this.$stackId = $stackId;
        this.$tenantId = $tenantId;
    }
    set(name, value) {
        const meta = {};
        if (this.$stackId) {
            meta.stackId = this.$stackId;
        }
        if (this.$tenantId) {
            meta.tenantId = this.$tenantId;
        }
        (0, set_1.setContextValue)(storage_1.putChainContext, this.$chainId, name, value, Object.keys(meta).length ? meta : undefined);
    }
    setStackId(stackId) {
        this.$stackId = stackId;
        this.set('$stackId', stackId);
    }
    setTenantId(tenantId) {
        this.$tenantId = tenantId;
        this.set('$tenantId', tenantId);
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
    static createContext(chainId, stackId, tenantId) {
        const context = new Context(chainId, stackId, tenantId);
        context.set('$chainId', chainId);
        if (stackId) {
            context.set('$stackId', stackId);
        }
        if (tenantId) {
            context.set('$tenantId', tenantId);
        }
        return context;
    }
}
exports.default = Context;
exports.Context = Context;
//# sourceMappingURL=index.js.map