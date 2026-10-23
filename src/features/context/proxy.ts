const WRAPPED = Symbol.for('fluid-func.wrapped');

export function toPOJO<T = Record<string, any>>(data: any): T {
    if (!data || typeof data !== 'object') {
        return data;
    }
    if (data instanceof Date || data instanceof RegExp || data instanceof Error) {
        return data as unknown as T;
    }
    const result: Record<string, any> = {};
    const keys = Object.keys(data);
    for (const key of keys) {
        if (key === '$$$validators' || key === '$chainId' || key === '$stackId') {
            continue;
        }
        if (key === '$signal' || key === 'signal' || key === '$namespace') {
            result[key] = data[key];
            continue;
        }
        let val: any;
        if (typeof data[key] === 'function') {
            try {
                val = data[key]();
            } catch {
                val = data[key];
            }
        } else {
            val = data[key];
        }
        if (val !== undefined) {
            if (typeof val === 'object' && val !== null && !(val instanceof Error) && !(val instanceof Date) && !(val instanceof RegExp) && typeof (val as any).addEventListener !== 'function') {
                if (Array.isArray(val)) {
                    result[key] = Object.freeze(val.map(item => (item && typeof item === 'object') ? toPOJO(item) : item));
                } else if (!val.then && typeof val !== 'function') {
                    result[key] = toPOJO(val);
                } else {
                    result[key] = val;
                }
            } else {
                result[key] = val;
            }
        }
    }
    return Object.freeze(result) as unknown as T;
}

export function wrapParam(data: Record<string, any>): Record<string, any> {
    if (!data || typeof data !== 'object' || (data as any)[WRAPPED]) {
        return data;
    }

    return new Proxy(data, {
        get(target, prop, receiver) {
            if (prop === WRAPPED) {
                return true;
            }
            if (typeof prop === 'symbol') {
                return Reflect.get(target, prop, receiver);
            }
            if (prop === 'toJSON') {
                return () => toPOJO(target);
            }
            if (prop === 'raw' || prop === 'props') {
                return toPOJO(target);
            }
            if (typeof prop === 'string' && prop.startsWith('$')) {
                return target[prop];
            }
            if (prop in Object.prototype) {
                return (target as any)[prop];
            }
            if (prop in target) {
                const desc = Object.getOwnPropertyDescriptor(target, prop);
                if (desc && !desc.configurable && !desc.writable) {
                    return target[prop];
                }

                const targetVal = target[prop];
                const rawVal = typeof targetVal === 'function'
                    ? ((targetVal as any).val !== undefined ? (targetVal as any).val : targetVal())
                    : targetVal;

                const accessor: any = (subField?: string) => {
                    if (subField !== undefined && rawVal !== undefined && rawVal !== null) {
                        return rawVal[subField];
                    }
                    return rawVal;
                };
                accessor.val = rawVal;
                accessor.valueOf = () => rawVal;
                accessor.toString = () => String(rawVal);
                accessor[Symbol.toPrimitive] = (hint: string) => {
                    if (hint === 'number') {
                        return Number(rawVal);
                    }
                    if (hint === 'string') {
                        return String(rawVal);
                    }
                    return rawVal;
                };

                if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal) && !(rawVal instanceof Date) && !(rawVal instanceof RegExp) && !(rawVal instanceof Error)) {
                    for (const k of Object.keys(rawVal)) {
                        Object.defineProperty(accessor, k, {
                            get() {
                                return rawVal[k];
                            },
                            enumerable: true,
                            configurable: true
                        });
                    }
                }

                return accessor;
            }
            return undefined;
        },
        has(target, prop) {
            return prop in target;
        },
        ownKeys(target) {
            return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, prop) {
            return Reflect.getOwnPropertyDescriptor(target, prop);
        }
    });
}
