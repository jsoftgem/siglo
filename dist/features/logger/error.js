"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logError = void 0;
const logError = (createLog, chain, error) => {
    return createLog(chain, error?.message, error);
};
exports.logError = logError;
//# sourceMappingURL=error.js.map