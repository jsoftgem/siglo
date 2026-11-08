/**
 * Utilities for dot-notation path traversal, wildcards, and immutable structural sharing.
 */

export function splitPath(pattern: string): string[] {
    return pattern.split('.').filter(Boolean);
}

/**
 * Returns all concrete paths in `obj` that match the wildcard pattern.
 * Supports '*' to match any object property or array index.
 */
export function getMatchingPaths(obj: unknown, pattern: string): (string | number)[][] {
    const segments = splitPath(pattern);
    const results: (string | number)[][] = [];

    function traverse(current: unknown, segmentIdx: number, currentPath: (string | number)[]) {
        if (segmentIdx >= segments.length) {
            results.push(currentPath);
            return;
        }

        if (current === null || current === undefined || typeof current !== 'object') {
            return;
        }

        const seg = segments[segmentIdx];

        if (seg === '*') {
            if (Array.isArray(current)) {
                for (let i = 0; i < current.length; i++) {
                    traverse(current[i], segmentIdx + 1, [...currentPath, i]);
                }
            } else {
                for (const key of Object.keys(current)) {
                    traverse((current as any)[key], segmentIdx + 1, [...currentPath, key]);
                }
            }
        } else {
            if (Array.isArray(current)) {
                const num = Number(seg);
                if (!Number.isNaN(num) && num in current) {
                    traverse(current[num], segmentIdx + 1, [...currentPath, num]);
                }
            } else if (seg in (current as any)) {
                traverse((current as any)[seg], segmentIdx + 1, [...currentPath, seg]);
            }
        }
    }

    traverse(obj, 0, []);
    return results;
}

/**
 * Retrieves the value at a concrete path.
 */
export function getValueAtPath(obj: unknown, path: (string | number)[]): unknown {
    let curr: any = obj;
    for (const part of path) {
        if (curr === null || curr === undefined) {
            return undefined;
        }
        curr = curr[part];
    }
    return curr;
}

/**
 * Immutably updates the value at a concrete path using structural sharing (copy-on-write).
 * Only the ancestor nodes along the path are cloned; sibling branches remain untouched.
 */
export function setValueAtPath(obj: any, path: (string | number)[], transform: (currentVal: unknown) => unknown): any {
    if (path.length === 0) {
        return transform(obj);
    }

    const [head, ...tail] = path;

    if (Array.isArray(obj)) {
        const copy = [...obj];
        const index = Number(head);
        const existingChild = copy[index];
        const childTarget =
            tail.length === 0
                ? existingChild
                : existingChild !== undefined && existingChild !== null && typeof existingChild === 'object'
                  ? existingChild
                  : typeof tail[0] === 'number'
                    ? []
                    : {};
        copy[index] = setValueAtPath(childTarget, tail, transform);
        return copy;
    }

    const copy = obj && typeof obj === 'object' ? { ...obj } : {};
    const existingChild = copy[head];
    const childTarget =
        tail.length === 0
            ? existingChild
            : existingChild !== undefined && existingChild !== null && typeof existingChild === 'object'
              ? existingChild
              : typeof tail[0] === 'number'
                ? []
                : {};
    copy[head] = setValueAtPath(childTarget, tail, transform);
    return copy;
}

/**
 * Transforms all fields in `obj` matching the provided string/keyof patterns.
 * Supports both top-level property keys and nested dot-notation/wildcard paths.
 */
export function transformFields(
    obj: any,
    patterns: (string | number | symbol)[],
    transform: (val: unknown, concretePath: (string | number)[]) => unknown,
): any {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }

    let result = obj;

    for (const pattern of patterns) {
        const patternStr = String(pattern);

        // If simple property key without dot or asterisk, fast-path with shallow clone
        if (!patternStr.includes('.') && !patternStr.includes('*')) {
            if (patternStr in result) {
                const val = result[patternStr];
                const transformed = transform(val, [patternStr]);
                if (transformed !== val) {
                    result = Array.isArray(result) ? [...result] : { ...result };
                    result[patternStr] = transformed;
                }
            }
            continue;
        }

        // Nested or wildcard pattern
        const matchingPaths = getMatchingPaths(result, patternStr);
        for (const concretePath of matchingPaths) {
            result = setValueAtPath(result, concretePath, curr => transform(curr, concretePath));
        }
    }

    return result;
}

/**
 * Deep freezes an object (used in dev mode to assert context immutability).
 */
export function deepFreeze<T>(obj: T): T {
    if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) {
        return obj;
    }
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
        const val = (obj as any)[key];
        if (val && typeof val === 'object' && !Object.isFrozen(val)) {
            deepFreeze(val);
        }
    }
    return obj;
}
