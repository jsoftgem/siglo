"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Util = void 0;
const context_1 = __importDefault(require("../context"));
const Util_1 = require("../../shared/Util");
class Util {
    static convertToContextStructure(param, ContextClass, generateUUID, stackId, tenantId) {
        let effContext = context_1.default;
        let effUUID = Util_1.generateUUID;
        let effStackId = stackId;
        let effTenantId = tenantId;
        if (typeof ContextClass === 'function' && ContextClass.createContext) {
            effContext = ContextClass;
            effUUID = typeof generateUUID === 'function' ? generateUUID : Util_1.generateUUID;
        }
        else {
            if (typeof ContextClass === 'string') {
                effUUID = () => ContextClass;
            }
            if (typeof generateUUID === 'string') {
                effStackId = generateUUID;
            }
            if (typeof stackId === 'string') {
                effTenantId = stackId;
            }
        }
        if (!(param instanceof effContext)) {
            const newParam = effContext.createContext(effUUID(), effStackId, effTenantId);
            for (const name in param) {
                if (Object.prototype.hasOwnProperty.call(param, name)) {
                    newParam.set(name, param[name]);
                }
            }
            return newParam.getData();
        }
        if (effStackId && !param.$stackId) {
            param.setStackId(effStackId);
        }
        if (effTenantId && !param.$tenantId) {
            param.setTenantId(effTenantId);
        }
        return param.getData();
    }
}
exports.Util = Util;
//# sourceMappingURL=util.js.map