import {
    STEP_ID,
    STACK_ID,
    VALIDATORS,
    SIGNAL,
    SIGNAL_KEY,
    NAMESPACE,
    SERVICES,
    DEPENDENCIES,
    DEPS,
    STEPS,
    HISTORY,
} from '../../shared';

export function toPOJO<T = Record<string, any>>(data: any): T {
    if (!data || typeof data !== 'object') {
        return data;
    }
    if (
        data instanceof Date ||
        data instanceof RegExp ||
        data instanceof Error ||
        (typeof ArrayBuffer !== 'undefined' && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) ||
        (typeof Blob !== 'undefined' && data instanceof Blob) ||
        typeof (data as any)[Symbol.asyncIterator] === 'function' ||
        typeof (data as any).pipe === 'function' ||
        typeof (data as any).spanContext === 'function'
    ) {
        return data as unknown as T;
    }
    const result: Record<string, any> = {};
    const keys = Object.keys(data);
    for (const key of keys) {
        if (
            key === VALIDATORS ||
            key === STEP_ID ||
            key === STACK_ID ||
            key === SERVICES ||
            key === DEPENDENCIES ||
            key === DEPS
        ) {
            continue;
        }
        if (
            key === SIGNAL ||
            key === SIGNAL_KEY ||
            key === NAMESPACE ||
            key === STEPS ||
            key === HISTORY ||
            key === '$steps' ||
            key === '$history'
        ) {
            result[key] = data[key];
            continue;
        }
        let val: any;
        if (typeof data[key] === 'function') {
            if (data[key].val !== undefined) {
                val = data[key].val;
            } else if ((data[key] as any)._isSigloComputed) {
                val = (data[key] as any).call(data);
            } else {
                // Functions and methods are omitted from serialization to prevent side effects
                continue;
            }
        } else {
            val = data[key];
        }
        if (val !== undefined) {
            const isBinaryOrNative =
                val instanceof Error ||
                val instanceof Date ||
                val instanceof RegExp ||
                (typeof ArrayBuffer !== 'undefined' && (val instanceof ArrayBuffer || ArrayBuffer.isView(val))) ||
                (typeof Blob !== 'undefined' && val instanceof Blob) ||
                (val !== null && typeof (val as any).addEventListener === 'function') ||
                (val !== null &&
                    (typeof (val as any)[Symbol.asyncIterator] === 'function' ||
                        typeof (val as any).pipe === 'function')) ||
                (val !== null && typeof (val as any).spanContext === 'function');

            if (typeof val === 'object' && val !== null && !isBinaryOrNative) {
                if (Array.isArray(val)) {
                    result[key] = Object.freeze(
                        val.map(item => (item && typeof item === 'object' ? toPOJO(item) : item)),
                    );
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
