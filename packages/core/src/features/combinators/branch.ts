import {Step, flow} from '../step';
import {toPOJO} from '../context';
import {generateUUID, isReservedKey, isFunction, isObject, WorkflowNodeType, safeClone} from '../../shared';
import {BranchNode, WorkflowNode, toGraph} from '../graph';
import {emitMonitoringEvent, stepInspectionStorage} from '../events';

function reportRoute(route: string): void {
    const scope = stepInspectionStorage.getStore();
    if (scope) emitMonitoringEvent({monitor: scope.monitor}, {
        type: 'branch:selected', stackId: scope.stackId, stepId: scope.stepId,
        stepName: scope.stepName, namespace: scope.namespace, route, timestamp: Date.now()
    });
}

export type BranchPredicate = (ctx: any, meta?: any) => boolean | Promise<boolean>;
export type BranchSelector = (ctx: any, meta?: any) => string | Promise<string>;

export const BranchRoute = {
    THEN: 'then',
    ELSE: 'else',
    DEFAULT: 'default'
} as const;

export type BranchRoute = (typeof BranchRoute)[keyof typeof BranchRoute];

function cleanBranchOutput(output: any): any {
    if (!isObject(output)) {
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
    return clean;
}

function executeBranchTarget(target: any, input: any, signal?: AbortSignal): Promise<any> {
    const isolatedInput = safeClone(toPOJO(input));
    const parentStackId = isFunction(input?.$stackId) ? input.$stackId() : (input?.$stackId || input?.stackId);
    const namespace = isFunction(input?.$namespace) ? input.$namespace() : (input?.$namespace || input?.namespace);
    const branchOptions: any = {signal, pojo: true, stackId: parentStackId, namespace};

    if (isFunction(target)) {
        return Promise.resolve(target(isolatedInput, branchOptions));
    }
    if (target && isFunction(target.execute)) {
        return target.execute(isolatedInput, branchOptions);
    }
    if (target && isFunction(target.run)) {
        return target.run(isolatedInput, branchOptions);
    }
    if (target && isFunction(target.start)) {
        return target.start(isolatedInput, branchOptions);
    }
    return flow(target).execute(isolatedInput, branchOptions);
}

export function when(
    predicate: BranchPredicate,
    thenStep: any,
    elseStep?: any
): Step<any, any> {
    const thenNode = toGraph(thenStep);
    const elseNode = elseStep ? toGraph(elseStep) : undefined;

    const branchNode: BranchNode = {
        id: generateUUID(),
        name: 'when',
        type: WorkflowNodeType.BRANCH,
        branches: {
            then: thenNode,
            ...(elseNode ? {else: elseNode} : {})
        },
        selector: predicate
    };

    const step = Step.create('when', async (param: any) => {
        const rawSig = param?.$signal || param?.signal;
        const signal = isFunction(rawSig) ? ((rawSig as any).val || rawSig()) : rawSig;
        const meta = {
            attempt: isFunction(param?.$attempt) ? param.$attempt() : param?.$attempt,
            stackId: isFunction(param?.$stackId) ? param.$stackId() : param?.$stackId,
            namespace: isFunction(param?.$namespace) ? param.$namespace() : param?.namespace
        };

        const isTrue = await predicate(toPOJO(param), meta);
        reportRoute(isTrue ? BranchRoute.THEN : BranchRoute.ELSE);

        if (isTrue) {
            const result = await executeBranchTarget(thenStep, param, signal);
            const cleaned = cleanBranchOutput(result);
            return {
                ...(isObject(cleaned) ? cleaned : {value: cleaned}),
                $branchSelected: BranchRoute.THEN,
                $skippedBranches: elseStep ? [BranchRoute.ELSE] : []
            };
        } else if (elseStep) {
            const result = await executeBranchTarget(elseStep, param, signal);
            const cleaned = cleanBranchOutput(result);
            return {
                ...(isObject(cleaned) ? cleaned : {value: cleaned}),
                $branchSelected: BranchRoute.ELSE,
                $skippedBranches: [BranchRoute.THEN]
            };
        } else {
            return {
                $branchSelected: undefined,
                $skippedBranches: [BranchRoute.THEN],
                $skipped: true
            };
        }
    });

    (step as any).workflowNode = branchNode;
    return step;
}

export function branch(
    selectorOrBranches: BranchSelector | Record<string, any>,
    branchesMap?: Record<string, any>,
    defaultBranch?: any
): Step<any, any> {
    let selector: BranchSelector;
    let branches: Record<string, any>;
    let fallback: any;

    if (isFunction(selectorOrBranches)) {
        selector = selectorOrBranches as BranchSelector;
        branches = branchesMap || {};
        fallback = defaultBranch;
    } else {
        branches = selectorOrBranches;
        fallback = branchesMap;
        selector = (ctx: any) => ctx.branch || ctx.status || ctx.choice || BranchRoute.DEFAULT;
    }

    const branchNodes: Record<string, WorkflowNode> = {};
    for (const key of Object.keys(branches)) {
        branchNodes[key] = toGraph(branches[key]);
    }
    const defaultNode = fallback ? toGraph(fallback) : undefined;

    const branchNode: BranchNode = {
        id: generateUUID(),
        name: 'branch',
        type: WorkflowNodeType.BRANCH,
        branches: branchNodes,
        selector,
        defaultBranch: defaultNode
    };

    const step = Step.create('branch', async (param: any) => {
        const rawSig = param?.$signal || param?.signal;
        const signal = isFunction(rawSig) ? ((rawSig as any).val || rawSig()) : rawSig;
        const meta = {
            attempt: isFunction(param?.$attempt) ? param.$attempt() : param?.$attempt,
            stackId: isFunction(param?.$stackId) ? param.$stackId() : param?.$stackId,
            namespace: isFunction(param?.$namespace) ? param.$namespace() : param?.namespace
        };

        const chosenKey = await selector(toPOJO(param), meta);
        const target = branches[chosenKey] || fallback;
        reportRoute(branches[chosenKey] ? chosenKey : BranchRoute.DEFAULT);
        const allKeys = Object.keys(branches);
        const skippedBranches = allKeys.filter(k => k !== chosenKey);

        if (!target) {
            return {
                $branchSelected: undefined,
                $skippedBranches: allKeys,
                $skipped: true
            };
        }

        const result = await executeBranchTarget(target, param, signal);
        const cleaned = cleanBranchOutput(result);
        return {
            ...(isObject(cleaned) ? cleaned : {value: cleaned}),
            $branchSelected: chosenKey,
            $skippedBranches: skippedBranches
        };
    });

    (step as any).workflowNode = branchNode;
    return step;
}
