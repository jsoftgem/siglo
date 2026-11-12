import assert from 'node:assert/strict';

/** Identity matters: a wrong failure ID must fail even when the failure count matches. */
export function assertExactIds(actual: string[], expected: string[]) {
    assert.deepEqual([...actual].sort(), [...expected].sort());
}
