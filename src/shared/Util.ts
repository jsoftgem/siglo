export const generateUUID = (): string => {
    let d = new Date().getTime();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (d + Math.random() * 16) % 16 | 0;
        d = Math.floor(d / 16);
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
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