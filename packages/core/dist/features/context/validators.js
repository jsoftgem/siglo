"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Validators = void 0;
const shared_1 = require("../../shared");
class Validators {
    chainId;
    getChainContext;
    CollectPromiseResult;
    constructor(chainId, getChainContext, CollectPromiseResult) {
        this.chainId = chainId;
        this.getChainContext = getChainContext;
        this.CollectPromiseResult = CollectPromiseResult;
    }
    addSpec(fieldSpec, setChainContextValue) {
        const oldValidators = this.getChainContext(this.chainId, shared_1.VALIDATORS);
        const validators = Object.assign([], [...(oldValidators ? oldValidators() : []), fieldSpec]);
        setChainContextValue(shared_1.VALIDATORS, validators);
    }
    runValidations(context) {
        const rawValidators = this.getChainContext(this.chainId, shared_1.VALIDATORS);
        const _validators = rawValidators ? rawValidators() : [];
        const validators = _validators.map((validator) => {
            if (validator.actions && validator.actions.includes('schema')) {
                return validator.runSchema(context);
            }
            return validator.runValidation(context);
        });
        return new Promise((resolve, reject) => {
            new this.CollectPromiseResult(validators).collect((result) => {
                if (result.error && result.error.length > 0) {
                    reject(result.error);
                }
                else {
                    resolve();
                }
            });
        });
    }
    runSpecs(context) {
        const rawValidators = this.getChainContext(this.chainId, shared_1.VALIDATORS);
        const _validators = rawValidators ? rawValidators() : [];
        const validators = _validators.map((validator) => {
            const promises = validator.actions.map((action) => {
                switch (action) {
                    case 'require':
                        return validator.runRequireValidation(context);
                    case 'validate':
                        return validator.runValidation(context);
                    case 'default':
                        return validator.runDefault(context);
                    case 'transform':
                        return validator.runTransform(context);
                    case 'translate':
                        return validator.runTranslate(context);
                    case 'schema':
                        return validator.runSchema(context);
                    default:
                        return Promise.resolve();
                }
            });
            return Promise.all(promises);
        });
        return new Promise((resolve, reject) => {
            new this.CollectPromiseResult(validators).collect((result) => {
                if (result.error && result.error.length > 0) {
                    reject(result.error);
                }
                else {
                    resolve();
                }
            });
        });
    }
}
exports.Validators = Validators;
//# sourceMappingURL=validators.js.map