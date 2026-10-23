"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class SetResolvedContexts {
    constructor(resolvedContext, context) {
        if (resolvedContext) {
            for (const field in resolvedContext) {
                if (Object.prototype.hasOwnProperty.call(resolvedContext, field)) {
                    const fieldData = resolvedContext[field];
                    context.set(field, fieldData);
                }
            }
        }
    }
}
exports.default = SetResolvedContexts;
//# sourceMappingURL=SetResolvedContexts.js.map