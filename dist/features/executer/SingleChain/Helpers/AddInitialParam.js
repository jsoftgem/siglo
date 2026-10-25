"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const shared_1 = require("../../../../shared");
class AddInitialParam {
    constructor(initialParam, context) {
        Object.keys(initialParam).forEach(field => {
            if (field !== shared_1.CHAIN_ID && field !== shared_1.VALIDATORS) {
                const val = typeof initialParam[field] === 'function' ? initialParam[field]() : initialParam[field];
                context.set(field, val);
            }
        });
    }
}
exports.default = AddInitialParam;
//# sourceMappingURL=AddInitialParam.js.map