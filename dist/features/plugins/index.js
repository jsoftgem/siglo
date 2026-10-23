"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeBeforePlugins = exports.executeAfterPlugins = exports.executeAfter = exports.executeBefore = void 0;
const after_1 = require("./after");
Object.defineProperty(exports, "executeAfterPlugins", { enumerable: true, get: function () { return after_1.executeAfterPlugins; } });
const before_1 = require("./before");
Object.defineProperty(exports, "executeBeforePlugins", { enumerable: true, get: function () { return before_1.executeBeforePlugins; } });
const storage_1 = require("../storage");
const executeBefore = (chain, context) => {
    return (0, before_1.executeBeforePlugins)(chain, context, (0, storage_1.getPlugins)());
};
exports.executeBefore = executeBefore;
const executeAfter = (chain, context) => {
    return (0, after_1.executeAfterPlugins)(chain, context, (0, storage_1.getPlugins)());
};
exports.executeAfter = executeAfter;
//# sourceMappingURL=index.js.map