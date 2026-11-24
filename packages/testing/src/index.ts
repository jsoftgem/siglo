import {
    ComputeCache,
    ComputeStep,
    ContextChangeEvent,
    ExecutionOptions,
    ExecutionPhase,
    Flow,
    flow,
    isFlow,
    resumeWorkflow,
    SerializedExecutionStack,
    SigloError,
    Step,
    StorageAdapter,
    getErrorMessage,
    isObject,
    toPOJO,
    useStorage,
} from '@siglo/core';

export type TestableWorkflow<TInput = any, TOutput = any> =
    Flow<TInput, TOutput> | Step<TInput, TOutput, string> | ComputeStep<TInput, TOutput, string>;

export interface StepTraceRecord {
    stepName: string;
    phase: 'start' | 'retry' | 'complete' | 'fail' | 'skip';
    timestamp: number;
    input: any;
    output?: any;
    error?: any;
    attempt?: number;
}

export interface ExecutionRecord {
    workflowVersion?: string | number;
    input: any;
    output?: any;
    error?: any;
    trace: StepTraceRecord[];
    recordedAt: string;
}

export interface ReplayOptions {
    substituteFixtures?: Record<string, any>;
    excludeKeys?: string[];
}

export interface ReplayResult {
    matched: boolean;
    expectedOutput: any;
    actualOutput: any;
    discrepancies: string[];
}

export class FakeClock {
    private currentTime: number;

    constructor(initialTime: number = Date.now()) {
        this.currentTime = initialTime;
    }

    now(): number {
        return this.currentTime;
    }

    advanceTime(ms: number): number {
        this.currentTime += ms;
        return this.currentTime;
    }

    tick(ms: number = 0): Promise<void> {
        this.advanceTime(ms);
        return new Promise(resolve => setImmediate(resolve));
    }

    reset(toTime: number = Date.now()): void {
        this.currentTime = toTime;
    }
}

function cloneCachedValue<T>(val: T): T {
    if (val === undefined || val === null || typeof val !== 'object') {
        return val;
    }
    try {
        return structuredClone(val);
    } catch {
        try {
            return JSON.parse(JSON.stringify(val)) as T;
        } catch {
            return val;
        }
    }
}

export class InMemoryStorageFake implements StorageAdapter {
    readonly name = 'in-memory-fake';
    private checkpoints = new Map<string, SerializedExecutionStack>();
    private cache = new Map<string, any>();
    public contextChanges: ContextChangeEvent[] = [];

    async onContextChange(event: ContextChangeEvent): Promise<void> {
        this.contextChanges.push(event);
    }

    async saveCheckpoint(checkpoint: SerializedExecutionStack): Promise<void> {
        const cpRecord = checkpoint as SerializedExecutionStack & { id?: string };
        const key = cpRecord.stackId || cpRecord.id || 'default';
        this.checkpoints.set(key, JSON.parse(JSON.stringify(checkpoint)) as SerializedExecutionStack);
    }

    async getCheckpoint(key: string): Promise<SerializedExecutionStack | undefined> {
        const item = this.checkpoints.get(key);
        return item ? (JSON.parse(JSON.stringify(item)) as SerializedExecutionStack) : undefined;
    }

    async getCachedStep(key: string): Promise<any> {
        return cloneCachedValue(this.cache.get(key));
    }

    async setCachedStep(key: string, val: any): Promise<void> {
        this.cache.set(key, cloneCachedValue(val));
    }

    clear(): void {
        this.checkpoints.clear();
        this.cache.clear();
        this.contextChanges = [];
    }

    getCheckpoints(): Map<string, SerializedExecutionStack> {
        return new Map(this.checkpoints);
    }
}

export class StepSpy {
    readonly name: string;
    readonly calls: Array<{ input: any; output?: any; error?: any; timestamp: number }> = [];

    constructor(name: string) {
        this.name = name;
    }

    get called(): boolean {
        return this.calls.length > 0;
    }

    get callCount(): number {
        return this.calls.length;
    }

    firstCall(): { input: any; output?: any; error?: any; timestamp: number } | undefined {
        return this.calls[0];
    }

    lastCall(): { input: any; output?: any; error?: any; timestamp: number } | undefined {
        return this.calls[this.calls.length - 1];
    }

    record(call: { input: any; output?: any; error?: any; timestamp: number }): void {
        this.calls.push(call);
    }
}

const DEFAULT_SECRET_KEYS = new Set([
    'password',
    'token',
    'secret',
    'authorization',
    'apikey',
    'api_key',
    'creditcard',
    'cardnumber',
    'cvv',
    'ssn',
    'privatekey',
    'private_key',
]);

export function sanitizeExecutionRecord(
    record: ExecutionRecord,
    options: { excludeKeys?: string[] } = {},
): ExecutionRecord {
    const customExcludes = new Set((options.excludeKeys || []).map(k => k.toLowerCase()));

    const sanitizeVal = (val: any): any => {
        if (!val || typeof val !== 'object') {
            return val;
        }
        if (Array.isArray(val)) {
            return val.map(sanitizeVal);
        }
        const clean: Record<string, any> = {};
        for (const [k, v] of Object.entries(val)) {
            const lowerKey = k.toLowerCase();
            if (DEFAULT_SECRET_KEYS.has(lowerKey) || customExcludes.has(lowerKey)) {
                clean[k] = '[REDACTED]';
            } else {
                clean[k] = sanitizeVal(v);
            }
        }
        return clean;
    };

    return {
        workflowVersion: record.workflowVersion,
        recordedAt: record.recordedAt,
        input: sanitizeVal(record.input),
        output: sanitizeVal(record.output),
        error: record.error !== undefined && record.error !== null ? getErrorMessage(record.error) : undefined,
        trace: record.trace.map(t => ({
            ...t,
            input: sanitizeVal(t.input),
            output: sanitizeVal(t.output),
        })),
    };
}

export interface HarnessOptions {
    services?: Record<string, unknown>;
    clock?: FakeClock;
    storage?: InMemoryStorageFake;
    recordTrace?: boolean;
}

function isThenable(value: unknown): value is PromiseLike<any> {
    return (
        value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        'then' in value &&
        typeof (value as { then?: unknown }).then === 'function'
    );
}

export class WorkflowHarness<TInput = any, TOutput = any> {
    private workflow: TestableWorkflow<TInput, TOutput>;
    private options: HarnessOptions;
    private mocks = new Map<string, (param: any) => any>();
    private spies = new Map<string, StepSpy>();
    private computeCaches = new Map<string, ComputeCache>();
    private trace: StepTraceRecord[] = [];
    private lastRunResult: any;
    public clock: FakeClock;
    public storage: InMemoryStorageFake;

    constructor(workflow: TestableWorkflow<TInput, TOutput>, options: HarnessOptions = {}) {
        this.workflow = workflow;
        this.options = options;
        this.clock = options.clock || new FakeClock();
        this.storage = options.storage || new InMemoryStorageFake();
    }

    mockStep(stepName: string, mockImpl: (param: any) => any): this {
        this.mocks.set(stepName, mockImpl);
        this.computeCaches.delete(stepName);
        return this;
    }

    spyStep(stepName: string): StepSpy {
        let spy = this.spies.get(stepName);
        if (!spy) {
            spy = new StepSpy(stepName);
            this.spies.set(stepName, spy);
        }
        return spy;
    }

    getTrace(): StepTraceRecord[] {
        return [...this.trace];
    }

    async injectEvent(_eventName: string, correlationKey: string, payload?: Record<string, unknown>): Promise<any> {
        const res = await resumeWorkflow(this.workflow as Flow<any, any>, correlationKey, payload, { pojo: true });
        return toPOJO(res);
    }

    private wrapWorkflowSteps(): Flow<any, any> {
        const rawSteps = isFlow(this.workflow) ? this.workflow.steps : [this.workflow];
        const wrappedSteps = rawSteps.map((origStep: any) => {
            const name = origStep.name || origStep.func || 'anonymous';
            const mockFn = this.mocks.get(name);
            const spy = this.spies.get(name);

            if (origStep?.isCompute === true) {
                const instrumentedSyncAction = (param: any) => {
                    const ts = this.clock.now();
                    this.trace.push({
                        stepName: name,
                        phase: 'start',
                        timestamp: ts,
                        input: toPOJO(param),
                        attempt: param?.$attempt || 1,
                    });

                    try {
                        const out = mockFn ? mockFn(param) : origStep.action(param);
                        if (isThenable(out)) {
                            if (out instanceof Promise) {
                                out.catch(() => {});
                            }
                            throw new SigloError(
                                `Step.compute '${name}' must be synchronous and cannot return a Promise. Use Step.create for async or I/O operations.`,
                                {
                                    stepName: name,
                                    phase: ExecutionPhase.ACTION,
                                    retryable: false,
                                },
                            );
                        }

                        if (spy) {
                            spy.record({ input: toPOJO(param), output: out, timestamp: ts });
                        }

                        this.trace.push({
                            stepName: name,
                            phase: 'complete',
                            timestamp: this.clock.now(),
                            input: toPOJO(param),
                            output: out,
                        });
                        return out;
                    } catch (err: unknown) {
                        if (spy) {
                            spy.record({ input: toPOJO(param), error: err, timestamp: ts });
                        }
                        this.trace.push({
                            stepName: name,
                            phase: 'fail',
                            timestamp: this.clock.now(),
                            input: toPOJO(param),
                            error: getErrorMessage(err),
                        });
                        throw err;
                    }
                };

                const clone = Object.assign(Object.create(Object.getPrototypeOf(origStep)), origStep);
                clone.action = instrumentedSyncAction;
                if (origStep._computeCache && typeof ComputeCache === 'function') {
                    let harnessCache = this.computeCaches.get(name);
                    if (!harnessCache) {
                        harnessCache = new ComputeCache({
                            ...(origStep.cacheOptions || {}),
                            ttl: origStep.cachedLast,
                        });
                        this.computeCaches.set(name, harnessCache);
                    }
                    clone._computeCache = harnessCache;
                }
                return clone;
            }

            const instrumentedAction = async (param: any) => {
                const ts = this.clock.now();
                this.trace.push({
                    stepName: name,
                    phase: 'start',
                    timestamp: ts,
                    input: toPOJO(param),
                    attempt: param?.$attempt || 1,
                });

                try {
                    let out: any;
                    if (mockFn) {
                        out = await mockFn(param);
                    } else {
                        out = await origStep.action(param);
                    }

                    if (spy) {
                        spy.record({ input: toPOJO(param), output: out, timestamp: ts });
                    }

                    this.trace.push({
                        stepName: name,
                        phase: 'complete',
                        timestamp: this.clock.now(),
                        input: toPOJO(param),
                        output: out,
                    });
                    return out;
                } catch (err: unknown) {
                    if (spy) {
                        spy.record({ input: toPOJO(param), error: err, timestamp: ts });
                    }
                    this.trace.push({
                        stepName: name,
                        phase: 'fail',
                        timestamp: this.clock.now(),
                        input: toPOJO(param),
                        error: getErrorMessage(err),
                    });
                    throw err;
                }
            };

            const clone = Object.assign(Object.create(Object.getPrototypeOf(origStep)), origStep);
            clone.action = instrumentedAction;
            return clone;
        });

        return flow(...wrappedSteps);
    }

    async run(input: any = {}, execOptions: ExecutionOptions = {}): Promise<any> {
        useStorage(this.storage);
        const instrumented = this.wrapWorkflowSteps();
        const mergedServices = {
            ...(this.options.services || {}),
            ...(execOptions.services || {}),
        };

        try {
            const result = await instrumented.run(input, {
                ...execOptions,
                services: mergedServices,
                pojo: execOptions.pojo !== false,
            });
            this.lastRunResult = result;
            return result;
        } catch (err: unknown) {
            const errRecord = isObject(err) ? err : undefined;
            const failedStepName =
                typeof errRecord?.stepName === 'string'
                    ? errRecord.stepName
                    : typeof errRecord?.func === 'string'
                      ? errRecord.func
                      : undefined;
            if (failedStepName) {
                const alreadyRecorded = this.trace.some(t => t.stepName === failedStepName && t.phase === 'fail');
                if (!alreadyRecorded) {
                    const ts = this.clock.now();
                    this.trace.push({
                        stepName: failedStepName,
                        phase: 'start',
                        timestamp: ts,
                        input: toPOJO(input),
                        attempt: 1,
                    });
                    const spy = this.spies.get(failedStepName);
                    if (spy) {
                        spy.record({ input: toPOJO(input), error: err, timestamp: ts });
                    }
                    this.trace.push({
                        stepName: failedStepName,
                        phase: 'fail',
                        timestamp: ts,
                        input: toPOJO(input),
                        error: getErrorMessage(err),
                    });
                }
            }
            throw err;
        }
    }

    async execute(input: any = {}, execOptions: ExecutionOptions = {}): Promise<any> {
        return this.run(input, execOptions);
    }

    assertStepExecuted(stepName: string, times?: number): void {
        const executions = this.trace.filter(t => t.stepName === stepName && t.phase === 'complete');
        if (times !== undefined) {
            if (executions.length !== times) {
                throw new Error(
                    `Expected step '${stepName}' to be executed ${times} time(s), but was executed ${executions.length} time(s).`,
                );
            }
        } else {
            if (executions.length === 0) {
                throw new Error(`Expected step '${stepName}' to be executed, but was not found in completed trace.`);
            }
        }
    }

    assertStepRetried(stepName: string, minAttempts: number = 2): void {
        const attempts = this.trace.filter(
            t => t.stepName === stepName && (t.phase === 'start' || t.phase === 'retry'),
        );
        if (attempts.length < minAttempts) {
            throw new Error(
                `Expected step '${stepName}' to have at least ${minAttempts} attempts, but found ${attempts.length}.`,
            );
        }
    }

    assertStepFailed(stepName: string, errorPattern?: string | RegExp): void {
        const failures = this.trace.filter(t => t.stepName === stepName && t.phase === 'fail');
        if (failures.length === 0) {
            throw new Error(`Expected step '${stepName}' to fail, but no failure was recorded in trace.`);
        }
        if (errorPattern) {
            const matched = failures.some(f => {
                const msg = f.error || '';
                return errorPattern instanceof RegExp ? errorPattern.test(msg) : msg.includes(errorPattern);
            });
            if (!matched) {
                throw new Error(
                    `Step '${stepName}' failed, but error did not match expected pattern '${errorPattern}'.`,
                );
            }
        }
    }

    exportExecutionRecord(options?: { excludeKeys?: string[] }): ExecutionRecord {
        const lastComplete = [...this.trace].reverse().find(t => t.phase === 'complete');
        const lastFail = [...this.trace].reverse().find(t => t.phase === 'fail');
        const firstStart = this.trace.find(t => t.phase === 'start');

        const rawRecord: ExecutionRecord = {
            workflowVersion: (this.workflow as any)?.workflowVersion,
            input: firstStart?.input || {},
            output: this.lastRunResult !== undefined ? this.lastRunResult : lastComplete?.output,
            error: lastFail?.error,
            trace: this.trace,
            recordedAt: new Date(this.clock.now()).toISOString(),
        };

        return sanitizeExecutionRecord(rawRecord, options);
    }
}

export function createWorkflowHarness<TInput = any, TOutput = any>(
    workflow: TestableWorkflow<TInput, TOutput>,
    options: HarnessOptions = {},
): WorkflowHarness<TInput, TOutput> {
    return new WorkflowHarness<TInput, TOutput>(workflow, options);
}

function normalizeForComparison(val: any): any {
    if (!val || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(normalizeForComparison);
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
        if (k === 'stackId' || k === '$stackId' || k === '$stepId' || k === '$steps' || k === '$history') {
            continue;
        }
        clean[k] = normalizeForComparison(v);
    }
    return clean;
}

export async function replayExecution(
    record: ExecutionRecord,
    workflow: TestableWorkflow<any, any>,
    options: ReplayOptions = {},
): Promise<ReplayResult> {
    const harness = createWorkflowHarness(workflow);

    if (options.substituteFixtures) {
        for (const [stepName, fixtureOutput] of Object.entries(options.substituteFixtures)) {
            harness.mockStep(stepName, () => fixtureOutput);
        }
    }

    let actualOutput: any;
    let actualError: string | undefined;
    try {
        actualOutput = await harness.run(record.input);
    } catch (err: unknown) {
        actualError = getErrorMessage(err);
    }

    const discrepancies: string[] = [];
    const cleanExpected = normalizeForComparison(record.output ?? null);
    const cleanActual = normalizeForComparison(actualOutput ?? null);
    const expectedJson = JSON.stringify(cleanExpected);
    const actualJson = JSON.stringify(cleanActual);

    if (expectedJson !== actualJson) {
        discrepancies.push(`Output mismatch: expected ${expectedJson}, received ${actualJson}`);
    }

    if (record.error && !actualError) {
        discrepancies.push(`Expected execution to fail with error '${record.error}', but succeeded.`);
    } else if (!record.error && actualError) {
        discrepancies.push(`Expected execution to succeed, but failed with '${actualError}'.`);
    }

    return {
        matched: discrepancies.length === 0,
        expectedOutput: record.output,
        actualOutput,
        discrepancies,
    };
}
