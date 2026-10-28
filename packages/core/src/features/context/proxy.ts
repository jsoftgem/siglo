import { CHAIN_ID, STACK_ID, VALIDATORS, SIGNAL, SIGNAL_KEY, NAMESPACE, SERVICES, DEPENDENCIES, DEPS, STEPS, HISTORY } from '../../shared';

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
        if (key === VALIDATORS || key === CHAIN_ID || key === STACK_ID || key === SERVICES || key === DEPENDENCIES || key === DEPS) {
            continue;
        }
        if (key === SIGNAL || key === SIGNAL_KEY || key === NAMESPACE || key === STEPS || key === HISTORY) {
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
