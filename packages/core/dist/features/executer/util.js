"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Util = void 0;
const context_1 = __importDefault(require("../context"));
const shared_1 = require("../../shared");
class Util {
    static convertToContextStructure(param, ContextClass, generateUUID, stackId, namespace) {
        let effContext = context_1.default;
        let effUUID = shared_1.generateUUID;
        let effStackId = stackId;
        let effNamespace = namespace;
        if (typeof ContextClass === 'function' && ContextClass.createContext) {
            effContext = ContextClass;
            effUUID = typeof generateUUID === 'function' ? generateUUID : shared_1.generateUUID;
        }
        else {
            if (typeof ContextClass === 'string') {
                effUUID = () => ContextClass;
            }
            if (typeof generateUUID === 'string') {
                effStackId = generateUUID;
            }
            if (typeof stackId === 'string') {
                effNamespace = stackId;
            }
        }
        if (!(param instanceof effContext)) {
            const newParam = effContext.createContext(effUUID(), effStackId, effNamespace);
            for (const name in param) {
                if (Object.prototype.hasOwnProperty.call(param, name)) {
                    newParam.set(name, param[name]);
                }
            }
            return newParam.getData();
        }
        if (effStackId && !param[shared_1.STACK_ID]) {
            param.setStackId(effStackId);
        }
        if (effNamespace && !param[shared_1.NAMESPACE]) {
            param.setNamespace(effNamespace);
        }
        return param.getData();
    }
}
exports.Util = Util;
//# sourceMappingURL=util.js.map