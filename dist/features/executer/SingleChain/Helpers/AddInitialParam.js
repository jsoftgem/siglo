"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class AddInitialParam {
    constructor(initialParam, context) {
        Object.keys(initialParam).forEach(field => {
            if (field !== '$chainId' && field !== '$$$validators') {
                const val = typeof initialParam[field] === 'function' ? initialParam[field]() : initialParam[field];
                context.set(field, val);
            }
        });
    }
}
exports.default = AddInitialParam;
//# sourceMappingURL=AddInitialParam.js.map