"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Util = exports.StartChain = exports.Runner = exports.Reducer = exports.ArrayChain = exports.Executer = exports.FlowTimeoutException = exports.StepTimeoutException = void 0;
const storage_1 = require("../storage");
const plugins_1 = require("../plugins");
const logger_1 = require("../logger");
const array_chain_1 = require("./array-chain");
Object.defineProperty(exports, "ArrayChain", { enumerable: true, get: function () { return array_chain_1.ArrayChain; } });
const context_1 = __importDefault(require("../context"));
const reducer_1 = require("./reducer");
Object.defineProperty(exports, "Reducer", { enumerable: true, get: function () { return reducer_1.Reducer; } });
const runner_1 = require("./runner");
Object.defineProperty(exports, "Runner", { enumerable: true, get: function () { return runner_1.Runner; } });
const StartChain_1 = __importDefault(require("./SingleChain/StartChain"));
exports.StartChain = StartChain_1.default;
const util_1 = require("./util");
Object.defineProperty(exports, "Util", { enumerable: true, get: function () { return util_1.Util; } });
const cache_1 = require("../cache");
const Util_1 = require("../../shared/Util");
var exceptions_1 = require("./exceptions");
Object.defineProperty(exports, "StepTimeoutException", { enumerable: true, get: function () { return exceptions_1.StepTimeoutException; } });
Object.defineProperty(exports, "FlowTimeoutException", { enumerable: true, get: function () { return exceptions_1.FlowTimeoutException; } });
class Executer {
    start(param, chains, options) {
        return new runner_1.Runner((c) => c, Util_1.generateUUID, context_1.default, StartChain_1.default, array_chain_1.ArrayChain, reducer_1.Reducer, util_1.Util, storage_1.createExecutionStack, storage_1.addChainToStack, storage_1.deleteStack, cache_1.cache, logger_1.logInfo, logger_1.logError, plugins_1.executeAfter, plugins_1.executeBefore).start(param, chains, options);
    }
}
exports.Executer = Executer;
//# sourceMappingURL=index.js.map