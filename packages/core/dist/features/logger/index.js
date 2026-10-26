"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLog = exports.logInfo = exports.logError = void 0;
const Log_1 = require("./Log");
Object.defineProperty(exports, "createLog", { enumerable: true, get: function () { return Log_1.createLog; } });
const error_1 = require("./error");
const info_1 = require("./info");
const storage_1 = require("../storage");
const logError = (chain, error) => {
    (0, storage_1.getLogMonitor)()((0, error_1.logError)(Log_1.createLog, chain, error));
};
exports.logError = logError;
const logInfo = (chain, message) => {
    (0, storage_1.getLogMonitor)()((0, info_1.logInfo)(Log_1.createLog, chain, message));
};
exports.logInfo = logInfo;
//# sourceMappingURL=index.js.map