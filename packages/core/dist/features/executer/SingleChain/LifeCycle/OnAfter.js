"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const context_1 = require("../../../context");
const shared_1 = require("../../../../shared");
class OnAfter {
    constructor(chain, output, param, context, propertyToContext, next, reject) {
        if ((0, shared_1.isFunction)(chain.onafter)) {
            try {
                const wrappedParam = (param && param.raw !== undefined) ? param : (0, context_1.wrapParam)(param);
                const actionParam = chain.isModern && wrappedParam?.raw !== undefined ? wrappedParam.raw : wrappedParam;
                const actionOutput = chain.isModern ? (0, context_1.toPOJO)(output) : output;
                const result = chain.onafter(actionOutput, actionParam);
                if (result instanceof Promise) {
                    result.then((enrichProps) => {
                        if (enrichProps !== undefined && propertyToContext) {
                            propertyToContext(context, enrichProps);
                        }
                        next();
                    }).catch((err) => {
                        reject(err);
                    });
                }
                else {
                    if (result !== undefined && propertyToContext) {
                        propertyToContext(context, result);
                    }
                    next();
                }
            }
            catch (err) {
                reject(err);
            }
        }
        else {
            next();
        }
    }
}
exports.default = OnAfter;
//# sourceMappingURL=OnAfter.js.map