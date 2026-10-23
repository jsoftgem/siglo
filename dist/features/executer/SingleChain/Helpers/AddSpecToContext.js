"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class AddSpecToContext {
    constructor(specs, context) {
        if (specs) {
            specs.forEach(spec => {
                context.addSpec(spec);
            });
        }
    }
}
exports.default = AddSpecToContext;
//# sourceMappingURL=AddSpecToContext.js.map