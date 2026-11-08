import { flow, parallel, race, allSettled, when, branch, map } from '@siglo/core';
import { step } from './step-helper';
import { RandomSource } from './property-generators';

export interface GeneratedStepMetadata {
    name: string;
    shouldFail: boolean;
    hasCompensation: boolean;
    hasTimeout: boolean;
    timeoutMs?: number;
    delayMs?: number;
}

export interface FuzzExecutionContext {
    executedSteps: string[];
    completedSteps: string[];
    compensatedSteps: string[];
    activeConcurrency: number;
    highWaterMark: number;
    events: Array<{ type: string; step: string; timestamp: number; payload?: any }>;
}

export interface GeneratedFlowResult {
    workflow: any;
    name: string;
    executionContext: FuzzExecutionContext;
    metadata: {
        stepCount: number;
        leafSteps: GeneratedStepMetadata[];
        depth: number;
    };
    resetExecution(): void;
}

export interface FlowGeneratorOptions {
    maxDepth?: number;
    errorProbability?: number;
    compensationProbability?: number;
    timeoutProbability?: number;
    delayProbability?: number;
}

export class FlowAstGenerator {
    private rng: RandomSource;

    constructor(seed: number = 42) {
        this.rng = new RandomSource(seed);
    }

    createExecutionContext(): FuzzExecutionContext {
        return {
            executedSteps: [],
            completedSteps: [],
            compensatedSteps: [],
            activeConcurrency: 0,
            highWaterMark: 0,
            events: [],
        };
    }

    private createStep(
        name: string,
        execCtx: FuzzExecutionContext,
        opts: FlowGeneratorOptions,
        leafSteps: GeneratedStepMetadata[],
    ): any {
        const shouldFail = this.rng.nextBoolean(opts.errorProbability ?? 0.1);
        const hasCompensation = this.rng.nextBoolean(opts.compensationProbability ?? 0.5);
        const hasDelay = this.rng.nextBoolean(opts.delayProbability ?? 0.3);
        const delayMs = hasDelay ? this.rng.nextInt(1, 10) : 0;
        const hasTimeout = this.rng.nextBoolean(opts.timeoutProbability ?? 0.1);
        const timeoutMs = hasTimeout ? (shouldFail ? 5 : 200) : undefined;

        leafSteps.push({
            name,
            shouldFail,
            hasCompensation,
            hasTimeout,
            timeoutMs,
            delayMs,
        });

        let s = step(name, async (ctx: any) => {
            try {
                if (delayMs > 0) {
                    await new Promise(r => setTimeout(r, delayMs));
                }

                if (shouldFail) {
                    execCtx.events.push({ type: 'fail', step: name, timestamp: Date.now() });
                    throw new Error(`Injected failure in step ${name}`);
                }

                execCtx.completedSteps.push(name);
                execCtx.events.push({ type: 'complete', step: name, timestamp: Date.now() });
                return { [`${name}_output`]: `value_${name}_${Date.now()}` };
            } finally {
                execCtx.activeConcurrency = Math.max(0, execCtx.activeConcurrency - 1);
            }
        }).onBefore(async () => {
            execCtx.executedSteps.push(name);
            execCtx.activeConcurrency++;
            if (execCtx.activeConcurrency > execCtx.highWaterMark) {
                execCtx.highWaterMark = execCtx.activeConcurrency;
            }
            execCtx.events.push({ type: 'start', step: name, timestamp: Date.now() });
            return true;
        });

        if (hasCompensation) {
            s = s.compensate(async (ctx: any) => {
                execCtx.compensatedSteps.push(name);
                execCtx.events.push({ type: 'compensate', step: name, timestamp: Date.now() });
            });
        }

        if (timeoutMs !== undefined) {
            s = s.timeout(timeoutMs);
        }

        return s;
    }

    generateFlow(
        name: string,
        depth: number,
        opts: FlowGeneratorOptions = {},
        execCtx?: FuzzExecutionContext,
        leafSteps: GeneratedStepMetadata[] = [],
    ): GeneratedFlowResult {
        const context = execCtx ?? this.createExecutionContext();

        const buildNode = (currName: string, currDepth: number): any => {
            if (currDepth <= 1) {
                return this.createStep(currName, context, opts, leafSteps);
            }

            const choices = ['sequence', 'parallel', 'race', 'allSettled', 'when', 'branch', 'map'];
            const construct = this.rng.pick(choices);

            switch (construct) {
                case 'parallel': {
                    const branchA = buildNode(`${currName}_pa`, currDepth - 1);
                    const branchB = buildNode(`${currName}_pb`, currDepth - 1);
                    return parallel([branchA, branchB]);
                }
                case 'race': {
                    const branchA = buildNode(`${currName}_ra`, currDepth - 1);
                    const branchB = buildNode(`${currName}_rb`, currDepth - 1);
                    return race([branchA, branchB]);
                }
                case 'allSettled': {
                    const branchA = buildNode(`${currName}_sa`, currDepth - 1);
                    const branchB = buildNode(`${currName}_sb`, currDepth - 1);
                    return allSettled([branchA, branchB]);
                }
                case 'map': {
                    const items = [1, 2, 3];
                    const concurrency = this.rng.nextInt(1, 3);
                    const mapStep = this.createStep(`${currName}_m`, context, opts, leafSteps);
                    return map(items, mapStep, { concurrency });
                }
                case 'when': {
                    const thenStep = buildNode(`${currName}_then`, currDepth - 1);
                    const elseStep = buildNode(`${currName}_else`, currDepth - 1);
                    const condition = (ctx: any) => Boolean(ctx && Math.random() > 0.5);
                    return when(condition, thenStep, elseStep);
                }
                case 'branch': {
                    const branchA = buildNode(`${currName}_ba`, currDepth - 1);
                    const branchB = buildNode(`${currName}_bb`, currDepth - 1);
                    const selector = () => (Math.random() > 0.5 ? 'optA' : 'optB');
                    return branch(selector, { optA: branchA, optB: branchB });
                }
                case 'sequence':
                default: {
                    const s1 = this.createStep(`${currName}_s1`, context, opts, leafSteps);
                    const s2 = buildNode(`${currName}_s2`, currDepth - 1);
                    return flow(s1, s2);
                }
            }
        };

        const rootFlow = flow(buildNode(name, depth));

        return {
            workflow: rootFlow,
            name,
            executionContext: context,
            metadata: {
                stepCount: leafSteps.length,
                leafSteps,
                depth,
            },
            resetExecution: () => {
                context.executedSteps.length = 0;
                context.completedSteps.length = 0;
                context.compensatedSteps.length = 0;
                context.activeConcurrency = 0;
                context.highWaterMark = 0;
                context.events.length = 0;
            },
        };
    }
}
