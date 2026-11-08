/**
 * Autonomous Invariant Oracles for siglo.
 * These oracles enforce the core system axioms across all randomized, chaos-injected exploratory tests.
 */

export class InvariantViolation extends Error {
    readonly oracleNumber: number;
    readonly oracleName: string;
    readonly details?: any;

    constructor(oracleNumber: number, oracleName: string, message: string, details?: any) {
        super(`[Oracle ${oracleNumber}: ${oracleName}] Invariant Violation: ${message}`);
        this.name = 'InvariantViolation';
        this.oracleNumber = oracleNumber;
        this.oracleName = oracleName;
        this.details = details;
    }
}

function normalizePojo(v: any): any {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(normalizePojo);
    const keys = Object.keys(v);
    if (keys.length > 0 && keys.every((k, i) => k === String(i))) {
        return keys.map(k => normalizePojo(v[k]));
    }
    const res: Record<string, any> = {};
    for (const k of keys) res[k] = normalizePojo(v[k]);
    return res;
}

export class InvariantEvaluator {
    /**
     * Oracle 1: Accumulated Context Immutability & Scope Isolation
     * Asserts that ancestral snapshots remain unaltered and Object.prototype was not polluted.
     */
    static assertContextImmutability(beforeSnapshot: any, afterContext: any, canaryKey: string = 'canary'): void {
        // 1. Prototype Pollution Check
        if (Object.prototype.hasOwnProperty(canaryKey) || (Object.prototype as any)[canaryKey] !== undefined) {
            delete (Object.prototype as any)[canaryKey];
            throw new InvariantViolation(
                1,
                'Context Immutability & Prototype Isolation',
                `Prototype pollution detected! Object.prototype has property "${canaryKey}".`,
            );
        }

        // 2. Ancestor Snapshot Integrity
        if (beforeSnapshot) {
            for (const [key, val] of Object.entries(beforeSnapshot)) {
                if (key.startsWith('$')) continue; // Skip internal metadata
                const currentVal = afterContext ? afterContext[key] : undefined;
                if (val !== null && typeof val === 'object') {
                    // Deep check for mutated nested keys if originally present
                    let originalJson: string | undefined;
                    let currentJson: string | undefined;
                    try {
                        originalJson = JSON.stringify(normalizePojo(val));
                        currentJson = JSON.stringify(normalizePojo(currentVal));
                    } catch {
                        // ignore circular references
                    }
                    if (
                        originalJson !== undefined &&
                        currentJson !== undefined &&
                        originalJson !== currentJson &&
                        currentVal !== undefined
                    ) {
                        throw new InvariantViolation(
                            1,
                            'Context Immutability & Scope Isolation',
                            `Ancestor key "${key}" was mutated! Original: ${originalJson}, Current: ${currentJson}`,
                        );
                    }
                }
            }
        }
    }

    /**
     * Oracle 2: Saga LIFO Compensation Ordering & Completeness
     * Asserts that compensations run in exact reverse order of successfully completed steps.
     */
    static assertSagaLIFO(
        completedSteps: readonly string[],
        compensatedSteps: readonly string[],
        failedStep?: string,
    ): void {
        const expectedOrder = [...completedSteps].reverse();

        // Compensated steps should be a prefix of expectedOrder
        for (let i = 0; i < compensatedSteps.length; i++) {
            const actual = compensatedSteps[i];
            const expected = expectedOrder[i];
            if (actual !== expected) {
                throw new InvariantViolation(
                    2,
                    'Saga LIFO Compensation Ordering',
                    `Compensations executed out-of-order at index ${i}. Expected step "${expected}", but got "${actual}". Completed: [${completedSteps.join(', ')}], Compensated: [${compensatedSteps.join(', ')}]`,
                    { completedSteps, compensatedSteps, failedStep },
                );
            }
        }

        if (failedStep && compensatedSteps.includes(failedStep)) {
            throw new InvariantViolation(
                2,
                'Saga LIFO Compensation Ordering',
                `Failed step "${failedStep}" must NOT have its compensation triggered because it did not complete successfully.`,
                { failedStep, compensatedSteps },
            );
        }
    }

    /**
     * Oracle 3: Optimistic Concurrency & Checkpoint Idempotency
     * Asserts that among N concurrent resume/write requests with the same version/checkpoint,
     * at most 1 writer succeeds and the others fail or receive consistent idempotency claims.
     */
    static assertOptimisticConcurrency(
        results: Array<{ status: 'fulfilled' | 'rejected'; value?: any; reason?: any }>,
    ): void {
        const fulfilled = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        if (fulfilled.length > 1) {
            // Check if outputs are identical (idempotent replay)
            const firstOutput = JSON.stringify(fulfilled[0].value);
            const allIdentical = fulfilled.every(r => JSON.stringify(r.value) === firstOutput);
            if (!allIdentical) {
                throw new InvariantViolation(
                    3,
                    'Optimistic Concurrency & Checkpoint Idempotency',
                    `Multiple concurrent writers succeeded with differing outputs! Divergent states detected. Success count: ${fulfilled.length}`,
                    { results, rejectedCount: rejected.length },
                );
            }
        }
    }

    /**
     * Oracle 4: Cooperative Cancellation & Resource Teardown
     * Asserts that an aborted flow halts execution and does not continue executing subsequent steps.
     */
    static assertCancellationPromptness(
        abortedStepName: string,
        allExecutedSteps: readonly string[],
        stepsDefinedAfterAbort: readonly string[],
    ): void {
        for (const stepName of stepsDefinedAfterAbort) {
            if (allExecutedSteps.includes(stepName)) {
                throw new InvariantViolation(
                    4,
                    'Cooperative Cancellation & Timer Teardown',
                    `Step "${stepName}" executed after workflow cancellation at "${abortedStepName}"! Execution must halt on AbortSignal.`,
                    { abortedStepName, allExecutedSteps, stepsDefinedAfterAbort },
                );
            }
        }
    }

    /**
     * Oracle 5: Bounded Concurrency Enforcement
     * Asserts that active worker concurrency never exceeded the configured maximum limit.
     */
    static assertBoundedConcurrency(highWaterMark: number, maxAllowed: number): void {
        if (highWaterMark > maxAllowed) {
            throw new InvariantViolation(
                5,
                'Bounded Concurrency Enforcement',
                `Active concurrent executions (${highWaterMark}) exceeded configured ceiling of ${maxAllowed}!`,
                { highWaterMark, maxAllowed },
            );
        }
    }

    /**
     * Oracle 6: Combinator Outcome Soundness
     * Asserts that combinators (race, allSettled, parallel, map, when) produce sound outcomes.
     */
    static assertCombinatorSoundness(
        combinator: 'race' | 'allSettled' | 'parallel' | 'map' | 'when',
        result: any,
        expectedCondition: { branchCount?: number; winnerExpected?: any; expectedErrors?: number },
    ): void {
        if (combinator === 'allSettled') {
            if (!Array.isArray(result) && typeof result === 'object' && result !== null) {
                const keys = Object.keys(result);
                if (expectedCondition.branchCount !== undefined && keys.length < expectedCondition.branchCount) {
                    throw new InvariantViolation(
                        6,
                        'Combinator Outcome Soundness',
                        `allSettled returned fewer branch results than input branches. Expected: ${expectedCondition.branchCount}, Got: ${keys.length}`,
                    );
                }
            }
        }
        if (combinator === 'map' && Array.isArray(result) && expectedCondition.branchCount !== undefined) {
            if (result.length !== expectedCondition.branchCount) {
                throw new InvariantViolation(
                    6,
                    'Combinator Outcome Soundness',
                    `map output length mismatch. Expected: ${expectedCondition.branchCount}, Got: ${result.length}`,
                );
            }
        }
    }

    /**
     * Oracle 7: Batch Stream Partial Failure Precision
     * Asserts set partition: ACKed ∩ NACKed == ∅ and ACKed ∪ NACKed == AllItems.
     */
    static assertBatchPartition(
        allItems: readonly string[],
        ackedItems: readonly string[],
        nackedItems: readonly string[],
    ): void {
        const ackSet = new Set(ackedItems);
        const nackSet = new Set(nackedItems);

        // Check intersection
        for (const id of ackSet) {
            if (nackSet.has(id)) {
                throw new InvariantViolation(
                    7,
                    'Batch Stream Partial Failure Precision',
                    `Item "${id}" was both ACKed and NACKed! Sets must be disjoint.`,
                    { id, ackedItems, nackedItems },
                );
            }
        }

        // Check union completeness
        for (const id of allItems) {
            if (!ackSet.has(id) && !nackSet.has(id)) {
                throw new InvariantViolation(
                    7,
                    'Batch Stream Partial Failure Precision',
                    `Item "${id}" was dropped! Neither ACKed nor NACKed.`,
                    { id, allItems, ackedItems, nackedItems },
                );
            }
        }
    }

    /**
     * Oracle 8: Two-Tier Timeout Determinism
     * Asserts that step timeouts fire when individual step exceeds duration,
     * and flow timeouts fire when aggregate workflow duration exceeds budget.
     */
    static assertTimeoutType(error: any, expectedType: 'step' | 'flow'): void {
        if (!error) {
            throw new InvariantViolation(
                8,
                'Two-Tier Timeout Determinism',
                'Expected timeout error, but no error was thrown!',
            );
        }
        const errorName = error.name || error.constructor?.name || '';
        if (expectedType === 'step' && !errorName.includes('StepTimeout')) {
            throw new InvariantViolation(
                8,
                'Two-Tier Timeout Determinism',
                `Expected StepTimeoutException, but received "${errorName}": ${error.message}`,
            );
        }
        if (expectedType === 'flow' && !errorName.includes('FlowTimeout')) {
            throw new InvariantViolation(
                8,
                'Two-Tier Timeout Determinism',
                `Expected FlowTimeoutException, but received "${errorName}": ${error.message}`,
            );
        }
    }

    /**
     * Oracle 9: Distributed Tracing & Span Continuity
     * Asserts that spans form a valid tree without disconnected orphan spans.
     */
    static assertSpanContinuity(spans: Array<{ id: string; parentId?: string; name: string }>): void {
        const spanIds = new Set(spans.map(s => s.id));
        const rootSpans = spans.filter(s => !s.parentId);

        if (spans.length > 0 && rootSpans.length === 0) {
            throw new InvariantViolation(
                9,
                'Distributed Tracing & Span Continuity',
                'No root span found in trace recording!',
            );
        }

        for (const span of spans) {
            if (span.parentId && !spanIds.has(span.parentId)) {
                throw new InvariantViolation(
                    9,
                    'Distributed Tracing & Span Continuity',
                    `Orphan span detected! Span "${span.name}" (${span.id}) references missing parent "${span.parentId}".`,
                );
            }
        }
    }

    /**
     * Oracle 10: Zero Resource & Event Listener Leaks
     * Asserts that active listener counts return to baseline after workflow execution.
     */
    static assertNoListenerLeak(
        emitter: { listenerCount(event: string | symbol): number },
        eventNames: string[],
        baselineCounts: Record<string, number>,
    ): void {
        for (const event of eventNames) {
            const current = emitter.listenerCount(event);
            const baseline = baselineCounts[event] ?? 0;
            if (current > baseline) {
                throw new InvariantViolation(
                    10,
                    'Zero Resource & Event Listener Leaks',
                    `Lingering event listeners on "${event}"! Baseline: ${baseline}, Current: ${current}`,
                );
            }
        }
    }
}
