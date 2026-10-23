"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const proxy_1 = require("../../../context/proxy");
class OnAfter {
    constructor(chain, output, param, context, propertyToContext, next, reject) {
        if (typeof chain.onafter === 'function') {
            try {
                const wrappedParam = (param && param.raw !== undefined) ? param : (0, proxy_1.wrapParam)(param);
                const actionParam = chain.isModern && wrappedParam?.raw !== undefined ? wrappedParam.raw : wrappedParam;
                const actionOutput = chain.isModern ? (0, proxy_1.toPOJO)(output) : output;
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