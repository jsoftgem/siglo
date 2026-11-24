export const isFunction = (val: unknown): val is (...args: any[]) => any => {
    return typeof val === 'function';
};

export const isObject = (val: unknown): val is Record<PropertyKey, any> => {
    return val !== null && typeof val === 'object';
};

export const isPlainObject = (val: unknown): val is Record<string, unknown> => {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
};

export function assertNever(value: never, context = 'Unexpected value'): never {
    throw new Error(`${context}: ${String(value)}`);
}

export function getErrorMessage(err: unknown, fallback = 'Unknown error'): string {
    if (err instanceof Error) {
        return err.message || fallback;
    }
    if (isObject(err) && typeof err.message === 'string') {
        return err.message || fallback;
    }
    return err !== undefined && err !== null ? String(err) : fallback;
}

export function getErrorName(err: unknown): string | undefined {
    if (err instanceof Error) {
        return err.name;
    }
    if (isObject(err) && typeof err.name === 'string') {
        return err.name;
    }
    return undefined;
}
