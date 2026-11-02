import {Step, flow} from '../step';
import {toPOJO} from '../context';
import {generateUUID, isReservedKey, VALUE, Status, isFunction, WorkflowNodeType, safeClone} from '../../shared';
import {ParallelNode, WorkflowNode, toGraph} from '../graph';
import {FieldCollisionException, CollisionDetail} from '../executer';
import {combineAbortSignals} from '../executer/signals';

export const ParallelMergeStrategy = {
    SHALLOW: 'shallow',
    DEEP: 'deep',
    ERROR: 'error',
} as const;

export type ParallelMergeStrategy = (typeof ParallelMergeStrategy)[keyof typeof ParallelMergeStrategy];

export const ParallelMode = {
    FAIL_FAST: 'fail-fast',
    ALL_SETTLED: 'allSettled',
    RACE: 'race',
} as const;

export type ParallelMode = (typeof ParallelMode)[keyof typeof ParallelMode];

export interface ParallelOptions {
    name?: string;
    mode?: ParallelMode | 'fail-fast' | 'allSettled' | 'race';
    mergeStrategy?: ParallelMergeStrategy | 'shallow' | 'deep' | 'error' | ((target: any, source: any, branchKey: string | number) => any);
}

export interface BranchExecutionSummary {
    name: string;
    index: number;
    status: typeof Status.COMPLETED | typeof Status.FAILED | typeof Status.CANCELLED;
    durationMs: number;
    output?: any;
    error?: any;
}

function cleanBranchOutput(output: any): any {
    if (!output || typeof output !== 'object') {
        return output;
    }
    const clean: Record<string, any> = {};
    for (const key of Object.keys(output)) {
        if (
            isReservedKey(key) ||
            isFunction(output[key])
        ) {
            continue;
        }
        clean[key] = output[key];
    }
    const cleanKeys = Object.keys(clean);
    if (cleanKeys.length === 1 && cleanKeys[0] === VALUE) {
        return clean[VALUE];
    }
    return clean;
}

function deepMerge(target: any, source: any): any {
    const output = Object.assign({}, target);
    for (const key of Object.keys(source)) {
        const sVal = source[key];
        const tVal = output[key];
        if (sVal && typeof sVal === 'object' && !Array.isArray(sVal) && tVal && typeof tVal === 'object' && !Array.isArray(tVal)) {
            output[key] = deepMerge(tVal, sVal);
        } else {
            output[key] = sVal;
        }
    }
    return output;
}

function detectCollisions(
    branchOutputs: Array<{ name: string; output: any }>
): CollisionDetail[] {
    const fieldValues = new Map<string, Array<{ branchName: string; value: any }>>();

    for (const b of branchOutputs) {
        if (b.output && typeof b.output === 'object') {
            for (const key of Object.keys(b.output)) {
                if (key.startsWith('$')) continue;
                const existing = fieldValues.get(key) || [];
                existing.push({branchName: b.name, value: b.output[key]});
                fieldValues.set(key, existing);
            }
        }
    }

    const collisions: CollisionDetail[] = [];
    for (const [field, entries] of fieldValues.entries()) {
        if (entries.length > 1) {
            const safeStr = (v: any) => {
                try { return JSON.stringify(v); } catch { return String(v); }
            };
            const firstValStr = safeStr(entries[0].value);
            const hasConflict = entries.some(e => safeStr(e.value) !== firstValStr);
            if (hasConflict) {
                collisions.push({
                    field,
                    values: entries.map(e => e.value),
                    branchNames: entries.map(e => e.branchName)
                });
            }
        }
    }

    return collisions;
}

function executeBranch(branch: any, input: any, signal?: AbortSignal): Promise<any> {
    const isolatedInput = safeClone(toPOJO(input));
    const parentStackId = typeof input?.$stackId === 'function' ? input.$stackId() : (input?.$stackId || input?.stackId);
    const namespace = typeof input?.$namespace === 'function' ? input.$namespace() : (input?.$namespace || input?.namespace);
    const branchOptions: any = {signal, pojo: true, stackId: parentStackId, namespace};

    if (typeof branch === 'function') {
        return Promise.resolve(branch(isolatedInput, branchOptions));
    }
    if (branch && typeof branch.execute === 'function') {
        return branch.execute(isolatedInput, branchOptions);
    }
    if (branch && typeof branch.run === 'function') {
        return branch.run(isolatedInput, branchOptions);
    }
    if (branch && typeof branch.start === 'function') {
        return branch.start(isolatedInput, branchOptions);
    }
    return flow(branch).execute(isolatedInput, branchOptions);
}

export function parallel(
    ...args: any[]
): Step<any, any> {
    let branches: any[] = [];
    let options: ParallelOptions = {};

    if (args.length === 1 && Array.isArray(args[0])) {
        branches = args[0];
    } else if (args.length === 2 && Array.isArray(args[0]) && typeof args[1] === 'object' && !args[1].action && !args[1].execute) {
        branches = args[0];
        options = args[1];
    } else {
        const last = args[args.length - 1];
        if (last && typeof last === 'object' && !Array.isArray(last) && !last.action && !last.execute && !last.run && !last.isFlow && !(last instanceof Step)) {
            options = last;
            branches = args.slice(0, -1);
        } else {
            branches = args;
        }
    }

    const mode: 'fail-fast' | 'allSettled' | 'race' = options.mode || 'fail-fast';
    const mergeStrategy = options.mergeStrategy || 'shallow';
    const stepName = options.name || (mode === 'race' ? 'race' : mode === 'allSettled' ? 'allSettled' : 'parallel');

    const branchNodes: WorkflowNode[] = branches.map(toGraph);
    const parallelNode: ParallelNode = {
        id: generateUUID(),
        name: stepName,
        type: WorkflowNodeType.PARALLEL,
        branches: branchNodes,
        mode,
        mergeStrategy
    };

    const step = Step.create(stepName, async (param: any) => {
        const rawSig = param?.$signal || param?.signal;
        const outerSignal = typeof rawSig === 'function' ? (rawSig.val || rawSig()) : rawSig;
        const innerController = new AbortController();
        const {signal: combinedSignal, cleanup: cleanupSignals} = combineAbortSignals([
            outerSignal,
            innerController.signal
        ]);

        const branchSummaries: BranchExecutionSummary[] = [];
        const startTime = Date.now();

        try {
            if (mode === 'race') {
                return await new Promise((resolve, reject) => {
                    let settled = false;
                    const promises = branches.map((branch, index) => {
                        const bName = branch?.name || branch?.func || `branch_${index}`;
                        const bStart = Date.now();
                        return executeBranch(branch, param, combinedSignal)
                            .then(res => {
                                if (!settled) {
                                    settled = true;
                                    innerController.abort();
                                    const cleaned = cleanBranchOutput(res);
                                    branchSummaries.push({
                                        name: bName,
                                        index,
                                        status: Status.COMPLETED,
                                        durationMs: Date.now() - bStart,
                                        output: cleaned
                                    });
                                    resolve(cleaned);
                                }
                            })
                            .catch(err => {
                                if (!settled) {
                                    settled = true;
                                    innerController.abort();
                                    branchSummaries.push({
                                        name: bName,
                                        index,
                                        status: Status.FAILED,
                                        durationMs: Date.now() - bStart,
                                        error: err
                                    });
                                    reject(err);
                                }
                            });
                    });
                    Promise.allSettled(promises).then(() => {
                        cleanupSignals();
                    });
                });
            }

            if (mode === 'allSettled') {
                const results = await Promise.allSettled(
                    branches.map(async (branch, index) => {
                        const bName = branch?.name || branch?.func || `branch_${index}`;
                        const bStart = Date.now();
                        try {
                            const res = await executeBranch(branch, param, combinedSignal);
                            const cleaned = cleanBranchOutput(res);
                            branchSummaries.push({
                                name: bName,
                                index,
                                status: Status.COMPLETED,
                                durationMs: Date.now() - bStart,
                                output: cleaned
                            });
                            return cleaned;
                        } catch (err: any) {
                            branchSummaries.push({
                                name: bName,
                                index,
                                status: Status.FAILED,
                                durationMs: Date.now() - bStart,
                                error: err
                            });
                            throw err;
                        }
                    })
                );

                const finalOutput: Record<string, any> = {
                    $branches: branchSummaries,
                    $settled: results
                };
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    const bName = branchSummaries[i]?.name || `branch_${i}`;
                    finalOutput[bName] = r.status === Status.FULFILLED ? cleanBranchOutput(r.value) : {error: r.reason};
                }
                return finalOutput;
            }

            // Default 'fail-fast'
            const branchOutputs: Array<{ name: string; output: any }> = [];
            const branchPromises = branches.map(async (branch, index) => {
                const bName = branch?.name || branch?.func || `branch_${index}`;
                const bStart = Date.now();
                try {
                    const out = await executeBranch(branch, param, combinedSignal);
                    const cleaned = cleanBranchOutput(out);
                    branchSummaries.push({
                        name: bName,
                        index,
                        status: Status.COMPLETED,
                        durationMs: Date.now() - bStart,
                        output: cleaned
                    });
                    branchOutputs.push({name: bName, output: cleaned});
                    return cleaned;
                } catch (err: any) {
                    innerController.abort();
                    branchSummaries.push({
                        name: bName,
                        index,
                        status: Status.FAILED,
                        durationMs: Date.now() - bStart,
                        error: err
                    });
                    throw err;
                }
            });

            await Promise.all(branchPromises);

            if (mergeStrategy === 'error') {
                const collisions = detectCollisions(branchOutputs);
                if (collisions.length > 0) {
                    throw new FieldCollisionException(collisions);
                }
            }

            let merged: Record<string, any> = {};
            if (typeof mergeStrategy === 'function') {
                for (let i = 0; i < branchOutputs.length; i++) {
                    merged = mergeStrategy(merged, branchOutputs[i].output, branchOutputs[i].name) || merged;
                }
            } else if (mergeStrategy === 'deep') {
                for (const b of branchOutputs) {
                    if (b.output && typeof b.output === 'object') {
                        merged = deepMerge(merged, b.output);
                    } else if (b.output !== undefined) {
                        merged[b.name] = b.output;
                    }
                }
            } else {
                for (const b of branchOutputs) {
                    if (b.output && typeof b.output === 'object') {
                        Object.assign(merged, b.output);
                    } else if (b.output !== undefined) {
                        merged[b.name] = b.output;
                    }
                }
            }

            merged.$branches = branchSummaries;
            merged.$timing = {
                durationMs: Date.now() - startTime
            };

            return merged;
        } finally {
            cleanupSignals();
        }
    });

    (step as any).workflowNode = parallelNode;
    return step;
}

export function all(
    branches: any[],
    options?: ParallelOptions
): Step<any, any> {
    return parallel(branches, {...options, mode: 'fail-fast'});
}

export function allSettled(
    branches: any[],
    options?: ParallelOptions
): Step<any, any> {
    return parallel(branches, {...options, mode: 'allSettled'});
}

export function race(
    ...args: any[]
): Step<any, any> {
    let branches: any[] = [];
    let options: ParallelOptions = {};

    if (args.length === 1 && Array.isArray(args[0])) {
        branches = args[0];
    } else if (args.length === 2 && Array.isArray(args[0]) && typeof args[1] === 'object' && !args[1].action && !args[1].execute) {
        branches = args[0];
        options = args[1];
    } else {
        const last = args[args.length - 1];
        if (last && typeof last === 'object' && !Array.isArray(last) && !last.action && !last.execute && !last.run && !last.isFlow && !(last instanceof Step)) {
            options = last;
            branches = args.slice(0, -1);
        } else {
            branches = args;
        }
    }

    return parallel(branches, {...options, mode: 'race'});
}
