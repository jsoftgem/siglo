"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidJSONValueException = exports.FunctionAsValueException = void 0;
exports.setContextValue = setContextValue;
function setContextValue(setChainContext, chainId, name, value, meta) {
    if (value instanceof Function) {
        throw new FunctionAsValueException();
    }
    setChainContext(chainId, name, value, meta);
}
class FunctionAsValueException extends Error {
    constructor() {
        super('Function cannot be set as value.');
    }
}
exports.FunctionAsValueException = FunctionAsValueException;
class InvalidJSONValueException extends Error {
    constructor(value) {
        super(`${value}  is not a valid json value.`);
    }
}
exports.InvalidJSONValueException = InvalidJSONValueException;
//# sourceMappingURL=set.js.map