"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const OnSkip_1 = __importDefault(require("./OnSkip"));
const context_1 = require("../../../context");
const shared_1 = require("../../../../shared");
class OnBefore {
    constructor(chain, param, resolve, reject, Context, next, propertyToContextOrStackId, stackId) {
        let propertyToContext;
        let actualStackId = stackId;
        if ((0, shared_1.isFunction)(propertyToContextOrStackId)) {
            propertyToContext = propertyToContextOrStackId;
        }
        else if (typeof propertyToContextOrStackId === 'string') {
            actualStackId = propertyToContextOrStackId;
        }
        const handleSkip = () => {
            new OnSkip_1.default(chain, param, resolve, reject, Context, propertyToContext, actualStackId);
        };
        try {
            const wrappedParam = (param && param.raw !== undefined) ? param : (0, context_1.wrapParam)(param);
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