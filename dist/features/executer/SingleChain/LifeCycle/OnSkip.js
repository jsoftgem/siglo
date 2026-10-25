"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const context_1 = require("../../../context");
const shared_1 = require("../../../../shared");
class OnSkip {
    constructor(chain, param, resolve, reject, Context, propertyToContext, stackId) {
        const context = Context.createContext(chain.$chainId, stackId);
        if ((0, shared_1.isFunction)(chain.onskip)) {
            try {
                const wrappedParam = (param && param.raw !== undefined) ? param : (0, context_1.wrapParam)(param);
                const actionParam = chain.isModern && wrappedParam?.raw !== undefined ? wrappedParam.raw : wrappedParam;
                const result = chain.onskip(actionParam);
                if (result instanceof Promise) {
                    result.then((fallbackProps) => {
                        if (fallbackProps !== undefined && propertyToContext) {
                            propertyToContext(context, fallbackProps);
                        }
                        resolve((0, context_1.wrapParam)(context.getData()));
                    }).catch((err) => {
                        reject(err);
                    });
                }
                else {
                    if (result !== undefined && propertyToContext) {
                        propertyToContext(context, result);
                    }
                    resolve((0, context_1.wrapParam)(context.getData()));
                }
            }
            catch (err) {
                reject(err);
            }
        }
        else {
            resolve(context.getData());
        }
    }
}
exports.default = OnSkip;
//# sourceMappingURL=OnSkip.js.map