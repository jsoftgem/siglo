import {
    flow,
    isFlow,
    StorageAdapter,
    useStorage,
    toPOJO,
    resumeWorkflow
} from 'fluid-func';

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

export class InMemoryStorageFake implements StorageAdapter {
    readonly name = 'in-memory-fake';
    private checkpoints = new Map<string, any>();
    private cache = new Map<string, any>();
    public contextChanges: any[] = [];

    async onContextChange(event: any): Promise<void> {
        this.contextChanges.push(event);
    }

    async saveCheckpoint(checkpoint: any): Promise<void> {
        const key = checkpoint.stackId || checkpoint.id || 'default';
        this.checkpoints.set(key, JSON.parse(JSON.stringify(checkpoint)));
    }

    async getCheckpoint(key: string): Promise<any> {
        const item = this.checkpoints.get(key);
        return item ? JSON.parse(JSON.stringify(item)) : undefined;
    }

    async getCachedStep(key: string): Promise<any> {
        return this.cache.get(key);
    }

    async setCachedStep(key: string, val: any): Promise<void> {
        this.cache.set(key, val);
    }

    clear(): void {
        this.checkpoints.clear();
        this.cache.clear();
        this.contextChanges = [];
    }

    getCheckpoints(): Map<string, any> {
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
    'private_key'
]);

export function sanitizeExecutionRecord(
    record: ExecutionRecord,
    options: { excludeKeys?: string[] } = {}
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
        error: record.error ? (record.error.message || String(record.error)) : undefined,
        trace: record.trace.map(t => ({
            ...t,
            input: sanitizeVal(t.input),
            output: sanitizeVal(t.output)
        }))
    };
}

export interface HarnessOptions {
    services?: Record<string, any>;
    clock?: FakeClock;
    storage?: InMemoryStorageFake;
    recordTrace?: boolean;
}

export class WorkflowHarness {
    private workflow: any;
    private options: HarnessOptions;
    private mocks = new Map<string, (param: any) => any>();
    private spies = new Map<string, StepSpy>();
    private trace: StepTraceRecord[] = [];
    private lastRunResult: any;
    public clock: FakeClock;
    public storage: InMemoryStorageFake;

    constructor(workflow: any, options: HarnessOptions = {}) {
        this.workflow = workflow;
        this.options = options;
        this.clock = options.clock || new FakeClock();
        this.storage = options.storage || new InMemoryStorageFake();
    }

    mockStep(stepName: string, mockImpl: (param: any) => any): this {
        this.mocks.set(stepName, mockImpl);
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

    async injectEvent(eventName: string, correlationKey: string, payload?: any): Promise<any> {
        const res = await resumeWorkflow(this.workflow, correlationKey, payload, { pojo: true });
        return toPOJO(res);
    }

    private wrapWorkflowSteps(): any {
        const rawSteps = isFlow(this.workflow) ? this.workflow.steps : [this.workflow];
        const wrappedSteps = rawSteps.map((origStep: any) => {
            const name = origStep.name || origStep.func || 'anonymous';
            const mockFn = this.mocks.get(name);
            const spy = this.spies.get(name);

            const instrumentedAction = async (param: any) => {
                const ts = this.clock.now();
                this.trace.push({
                    stepName: name,
                    phase: 'start',
                    timestamp: ts,
                    input: toPOJO(param),
                    attempt: param?.$attempt || 1
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
                        output: out
                    });
                    return out;
                } catch (err: any) {
                    if (spy) {
                        spy.record({ input: toPOJO(param), error: err, timestamp: ts });
                    }
                    this.trace.push({
                        stepName: name,
                        phase: 'fail',
                        timestamp: this.clock.now(),
                        input: toPOJO(param),
                        error: err?.message || String(err)
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

    async run(input: any = {}, execOptions: any = {}): Promise<any> {
        useStorage(this.storage);
        const instrumented = this.wrapWorkflowSteps();
        const mergedServices = {
            ...(this.options.services || {}),
            ...(execOptions.services || {})
        };

        const result = await instrumented.run(input, {
            ...execOptions,
            services: mergedServices,
            pojo: execOptions.pojo !== false
        });
        this.lastRunResult = result;
        return result;
    }

    async execute(input: any = {}, execOptions: any = {}): Promise<any> {
        return this.run(input, execOptions);
    }

    assertStepExecuted(stepName: string, times?: number): void {
        const executions = this.trace.filter(t => t.stepName === stepName && t.phase === 'complete');
        if (times !== undefined) {
            if (executions.length !== times) {
                throw new Error(`Expected step '${stepName}' to be executed ${times} time(s), but was executed ${executions.length} time(s).`);
            }
        } else {
            if (executions.length === 0) {
                throw new Error(`Expected step '${stepName}' to be executed, but was not found in completed trace.`);
            }
        }
    }

    assertStepRetried(stepName: string, minAttempts: number = 2): void {
        const attempts = this.trace.filter(t => t.stepName === stepName && (t.phase === 'start' || t.phase === 'retry'));
        if (attempts.length < minAttempts) {
            throw new Error(`Expected step '${stepName}' to have at least ${minAttempts} attempts, but found ${attempts.length}.`);
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
                throw new Error(`Step '${stepName}' failed, but error did not match expected pattern '${errorPattern}'.`);
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
            recordedAt: new Date(this.clock.now()).toISOString()
        };

        return sanitizeExecutionRecord(rawRecord, options);
    }
}

export function createWorkflowHarness(workflow: any, options: HarnessOptions = {}): WorkflowHarness {
    return new WorkflowHarness(workflow, options);
}

function normalizeForComparison(val: any): any {
    if (!val || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(normalizeForComparison);
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
        if (k === 'stackId' || k === '$stackId' || k === '$stepId' || k === '$chainId' || k === '$steps' || k === '$history') {
            continue;
        }
        clean[k] = normalizeForComparison(v);
    }
    return clean;
}

export async function replayExecution(
    record: ExecutionRecord,
    workflow: any,
    options: ReplayOptions = {}
): Promise<ReplayResult> {
    const harness = createWorkflowHarness(workflow);

    if (options.substituteFixtures) {
        for (const [stepName, fixtureOutput] of Object.entries(options.substituteFixtures)) {
            harness.mockStep(stepName, () => fixtureOutput);
        }
    }

    let actualOutput: any;
    let actualError: any;
    try {
        actualOutput = await harness.run(record.input);
    } catch (err: any) {
        actualError = err.message || String(err);
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
        discrepancies
    };
}
