export function setContextValue(
    setChainContext: (chainId: string, name: string, value: any, meta?: any) => void,
    chainId: string,
    name: string,
    value: any,
    meta?: any
): void {
    if (value instanceof Function) {
        throw new FunctionAsValueException();
    }
    setChainContext(chainId, name, value, meta);
}

export class FunctionAsValueException extends Error {
    constructor() {
        super('Function cannot be set as value.');
    }
/* c8 ignore next */
}

export class InvalidJSONValueException extends Error {
    constructor(value: any) {
        super(`${value}  is not a valid json value.`);
    }
/* c8 ignore next */
}
