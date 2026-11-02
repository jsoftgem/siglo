import { randomUUID } from 'crypto';

export const generateUUID = (): string => {
    return randomUUID();
};

export const batchIn = (
    object: Record<string, any>,
    next: (value: any, nextCb: () => void) => void,
    done: () => void
): void => {
    const keys = Object.keys(object);
    batchForObject(keys, object, next, done);
};

function batchForObject(
    keys: string[],
    object: Record<string, any>,
    next: (value: any, nextCb: () => void) => void,
    done: () => void,
    index = 0
): void {
    if (index < keys.length) {
        const value = object[keys[index]];
        next(value, () => {
            batchForObject(keys, object, next, done, ++index);
        });
    } else {
        done();
    }
}

export const batch = (
    array: any[],
    next: (value: any, nextCb: () => void) => void,
    done: () => void,
    index = 0
): void => {
    if (index < array.length) {
        const value = array[index];
        next(value, () => {
            batch(array, next, done, ++index);
        });
    } else {
        done();
    }
};

export function isValidJson(json: string): boolean {
    try {
        JSON.parse(json);
        return true;
    } catch {
        return false;
    }
}

export function safeClone<T>(val: T, seen = new WeakMap<any, any>()): T {
    if (val === null || typeof val !== 'object') {
        return val;
    }
    if (seen.has(val)) {
        return seen.get(val);
    }
    if (val instanceof Date) {
        return new Date(val.getTime()) as any;
    }
    if (val instanceof RegExp) {
        return new RegExp(val.source, val.flags) as any;
    }
    if (val instanceof Error) {
        return val;
    }
    if (typeof ArrayBuffer !== 'undefined' && (val instanceof ArrayBuffer || ArrayBuffer.isView(val))) {
        return val;
    }
    if (val instanceof Map) {
        const copy = new Map();
        seen.set(val, copy);
        for (const [k, v] of val.entries()) {
            copy.set(safeClone(k, seen), safeClone(v, seen));
        }
        return copy as any;
    }
    if (val instanceof Set) {
        const copy = new Set();
        seen.set(val, copy);
        for (const item of val) {
            copy.add(safeClone(item, seen));
        }
        return copy as any;
    }
    if (Array.isArray(val)) {
        const copy: any[] = [];
        seen.set(val, copy);
        for (let i = 0; i < val.length; i++) {
            copy[i] = safeClone(val[i], seen);
        }
        return copy as any;
    }
    const copy: Record<string, any> = {};
    seen.set(val, copy);
    for (const key of Object.keys(val)) {
        const propVal = (val as any)[key];
        if (typeof propVal === 'function') {
            continue;
        }
        copy[key] = safeClone(propVal, seen);
    }
    return copy as any;
}

export interface PromiseCollectResult<T = any> {
    success: T[];
    error: any[];
}

export interface PromiseStepResult<T = any> {
    success?: boolean;
    failed?: boolean;
    data?: T;
    error?: any;
}

export class CollectPromiseResult<T = any> {
    private promises: Promise<T>[];

    constructor(promises: Promise<T>[]) {
        this.promises = [...promises];
    }

    collect(
        callback: (result: PromiseCollectResult<T>) => void,
        results: PromiseStepResult<T>[] = []
    ): void {
        if (this.promises.length > 0) {
            const promise = this.promises.shift();
            if (promise) {
                promise
                    .then(data => {
                        results.push({success: true, data});
                        new CollectPromiseResult(this.promises).collect(callback, results);
                    })
                    .catch(error => {
                        results.push({failed: true, error});
                        new CollectPromiseResult(this.promises).collect(callback, results);
                    });
            }
        } else {
            const error = results.filter(result => result.failed).map(result => result.error);
            const success = results.filter(result => result.success).map(result => result.data as T);
            callback({
                error,
                success
            });
        }
    }

    /* c8 ignore next */
}
