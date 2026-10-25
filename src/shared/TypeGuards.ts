export const isFunction = (val: unknown): val is (...args: any[]) => any => {
    return typeof val === 'function';
};

export const isObject = (val: unknown): val is Record<PropertyKey, any> => {
    return val !== null && typeof val === 'object';
};
