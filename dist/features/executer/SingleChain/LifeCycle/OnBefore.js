"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const OnSkip_1 = __importDefault(require("./OnSkip"));
const proxy_1 = require("../../../context/proxy");
class OnBefore {
    constructor(chain, param, resolve, reject, Context, next, propertyToContextOrStackId, stackId) {
        let propertyToContext;
        let actualStackId = stackId;
        if (typeof propertyToContextOrStackId === 'function') {
            propertyToContext = propertyToContextOrStackId;
        }
        else if (typeof propertyToContextOrStackId === 'string') {
            actualStackId = propertyToContextOrStackId;
        }
        const handleSkip = () => {
            new OnSkip_1.default(chain, param, resolve, reject, Context, propertyToContext, actualStackId);
        };
        try {
            const wrappedParam = (param && param.raw !== undefined) ? param : (0, proxy_1.wrapParam)(param);
            const actionParam = chain.isModern && wrappedParam?.raw !== undefined ? wrappedParam.raw : wrappedParam;
            const onbefore = chain.onbefore(actionParam);
            if (onbefore instanceof Promise) {
                onbefore.then((con) => {
                    if (con) {
                        next();
                    }
                    else {
                        handleSkip();
                    }
                }).catch((err) => {
                    reject(err);
                });
            }
            else if (onbefore) {
                next();
            }
            else {
                handleSkip();
            }
        }
        catch (err) {
            reject(err);
        }
    }
}
exports.default = OnBefore;
//# sourceMappingURL=OnBefore.js.map