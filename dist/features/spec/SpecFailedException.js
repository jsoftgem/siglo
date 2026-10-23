"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpecFailedException = void 0;
class SpecFailedException {
    constructor(procedure, field, reject) {
        try {
            procedure();
        }
        catch (error) {
            if (reject) {
                reject({
                    field,
                    error
                });
            }
            else {
                throw new Error('SpecFailedException: ' + error?.message);
            }
        }
    }
}
exports.SpecFailedException = SpecFailedException;
//# sourceMappingURL=SpecFailedException.js.map