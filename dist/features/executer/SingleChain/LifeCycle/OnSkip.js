"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const proxy_1 = require("../../../context/proxy");
class OnSkip {
    constructor(chain, param, resolve, reject, Context, propertyToContext, stackId) {
        const context = Context.createContext(chain.$chainId, stackId);
        if (typeof chain.onskip === 'function') {
            try {
                const wrappedParam = (param && param.raw !== undefined) ? param : (0, proxy_1.wrapParam)(param);
                const actionParam = chain.isModern && wrappedParam?.raw !== undefined ? wrappedParam.raw : wrappedParam;
                const result = chain.onskip(actionParam);
                if (result instanceof Promise) {
                    result.then((fallbackProps) => {
                        if (fallbackProps !== undefined && propertyToContext) {
                            propertyToContext(context, fallbackProps);
                        }
                        resolve((0, proxy_1.wrapParam)(context.getData()));
                    }).catch((err) => {
                        reject(err);
                    });
                }
                else {
                    if (result !== undefined && propertyToContext) {
                        propertyToContext(context, result);
                    }
                    resolve((0, proxy_1.wrapParam)(context.getData()));
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