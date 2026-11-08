import { Step, flow } from '../step';
import { toPOJO } from '../context';
import { generateUUID, isReservedKey, VALUE, Status, isFunction, isObject, WorkflowNodeType } from '../../shared';
import { toGraph, MapNode } from '../graph';
import { combineAbortSignals } from '../executer/signals';
import { stepExecutionHookStorage } from '../executer/hooks';

export interface MapOptions {
    name?: string;
    concurrency?: number;
    stopOnError?: boolean;
    preserveOrder?: boolean;
}

export type MapItemAccessor =
    | any[]
    | AsyncIterable<any>
    | Iterable<any>
    | ((ctx: any) => any[] | AsyncIterable<any> | Iterable<any> | Promise<any[] | AsyncIterable<any> | Iterable<any>>);

const MAP_METADATA_KEYS = new Set(['item', 'index', 'total']);

function cleanStepOutput(output: any): any {
    if (!isObject(output)) {
        return output;
    }
    const clean: Record<string, any> = {};
    for (const key of Object.keys(output)) {
        if (isReservedKey(key) || MAP_METADATA_KEYS.has(key) || isFunction(output[key])) {
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

function executeItem(
    processItem: any,
    item: any,
    meta: {
        index: number;
        total?: number;
        signal?: AbortSignal;
        stackId?: string;
        namespace?: string;
    },
): Promise<any> {
    if (isFunction(processItem)) {
        return Promise.resolve(processItem(item, meta));
    }
    const input = { item, ...meta };
    const hook = stepExecutionHookStorage.getStore();
    const branchOptions: any = {
        signal: meta.signal,
        pojo: true,
        stackId: meta.stackId,
        namespace: meta.namespace,
        ...(hook ? { stepExecutionHook: hook } : {}),
    };
    let p: Promise<any>;
    if (processItem && isFunction(processItem.execute)) {
        p = processItem.execute(input, branchOptions);
    } else if (processItem && isFunction(processItem.run)) {
        p = processItem.run(input, branchOptions);
    } else if (processItem && isFunction(processItem.start)) {
        p = processItem.start(input, branchOptions);
    } else {
        p = flow(processItem).execute(input, branchOptions);
    }
    return p.then(cleanStepOutput);
}

export function map(itemsOrAccessor: MapItemAccessor, processItem: any, options?: MapOptions): Step<any, any> {
    const concurrency = Math.max(1, options?.concurrency ?? 10);
    const stopOnError = options?.stopOnError !== false; // default true
    const preserveOrder = options?.preserveOrder !== false; // default true
    const stepName = options?.name || 'map';

    const mapNode: MapNode = {
        id: generateUUID(),
        name: stepName,
        type: WorkflowNodeType.MAP,
        itemNode: toGraph(processItem),
        concurrency,
        stopOnError,
        preserveOrder,
    };

    const step = Step.create(stepName, async (param: any) => {
        const rawSig = param?.$signal || param?.signal;
        const outerSignal = isFunction(rawSig) ? (rawSig as any).val || rawSig() : rawSig;
        const parentStackId = isFunction(param?.$stackId) ? param.$stackId() : param?.$stackId || param?.stackId;
        const namespace = isFunction(param?.$namespace) ? param.$namespace() : param?.$namespace || param?.namespace;
        const innerController = new AbortController();
        const { signal: combinedSignal, cleanup: cleanupSignals } = combineAbortSignals([
            outerSignal,
            innerController.signal,
        ]);

        try {
            let rawItems: any;
            if (isFunction(itemsOrAccessor)) {
                rawItems = await itemsOrAccessor(toPOJO(param));
            } else {
                rawItems = itemsOrAccessor;
            }

            const isArray = Array.isArray(rawItems);
            let total: number | undefined = isArray ? rawItems.length : undefined;

            let iterator: any;
            if (rawItems && isFunction(rawItems[Symbol.asyncIterator])) {
                iterator = rawItems[Symbol.asyncIterator]();
            } else if (rawItems && isFunction(rawItems[Symbol.iterator])) {
                iterator = rawItems[Symbol.iterator]();
            } else {
                rawItems = [];
                iterator = [][Symbol.iterator]();
                total = 0;
            }

            const results: Array<{ index: number; value?: any; error?: any; status: Status }> = [];
            let currentIndex = 0;
            let hasError = false;
            let firstError: any = undefined;

            let pullLock: Promise<any> = Promise.resolve();
            function pullNext(): Promise<{ item: any; index: number; done: boolean }> {
                const nextPromise = pullLock.then(async () => {
                    const next = await iterator.next();
                    if (next.done) {
                        return { item: undefined, index: -1, done: true };
                    }
                    const idx = currentIndex++;
                    return { item: next.value, index: idx, done: false };
                });
                pullLock = nextPromise.catch(() => ({ item: undefined, index: -1, done: true }));
                return nextPromise;
            }

            async function worker(): Promise<void> {
                while (true) {
                    if (combinedSignal?.aborted) break;
                    if (hasError && stopOnError) break;

                    const { item, index, done } = await pullNext();
                    if (done) break;

                    try {
                        const val = await executeItem(processItem, item, {
                            index,
                            total,
                            signal: combinedSignal,
                            stackId: parentStackId,
                            namespace,
                        });
                        results.push({ index, value: val, status: Status.FULFILLED });
                    } catch (err: any) {
                        results.push({ index, error: err, status: Status.REJECTED });
                        if (stopOnError) {
                            hasError = true;
                            firstError = err;
                            innerController.abort();
                            break;
                        }
                    }
                }
            }

            const workerCount = Math.min(concurrency, total !== undefined ? Math.max(1, total) : concurrency);
            const workers: Promise<void>[] = [];
            for (let i = 0; i < workerCount; i++) {
                workers.push(worker());
            }

            await Promise.all(workers);

            if (combinedSignal?.aborted && !hasError) {
                throw combinedSignal.reason || new Error('This operation was aborted');
            }

            if (hasError && stopOnError) {
                throw firstError;
            }

            if (preserveOrder) {
                results.sort((a, b) => a.index - b.index);
            }

            const outputItems = results.map(r => (r.status === Status.FULFILLED ? r.value : { error: r.error }));
            const errors = results.filter(r => r.status === Status.REJECTED).map(r => r.error);

            return {
                items: outputItems,
                count: outputItems.length,
                ...(errors.length > 0 ? { errors } : {}),
            };
        } finally {
            cleanupSignals();
        }
    });

    (step as any).workflowNode = mapNode;
    return step;
}
