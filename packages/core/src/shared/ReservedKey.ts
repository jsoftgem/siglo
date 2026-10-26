export const ReservedKey = {
    // Core Context & Reserved Keys
    STEPS: '$steps',
    HISTORY: '$history',
    SIGNAL: '$signal',
    CHAIN_ID: '$chainId',
    STACK_ID: '$stackId',
    NAMESPACE: '$namespace',
    SERVICES: '$services',
    DEPENDENCIES: '$dependencies',
    DEPS: '$deps',
    VALIDATORS: '$$$validators',

    // Raw parameter property names (without $)
    STACK_ID_KEY: 'stackId',
    SIGNAL_KEY: 'signal',
    NAMESPACE_KEY: 'namespace',

    // Workflow / Execution metadata keys
    STEP_ID: '$stepId',
    ATTEMPT: '$attempt',
    RETRY_DELAY: '$retryDelay',
    IS_DURABLE: '$isDurable',
    WORKFLOW_ID: '$workflowId',
    BRANCH_SELECTED: '$branchSelected',
    SKIPPED_BRANCHES: '$skippedBranches',
    SKIPPED: '$skipped',
    BRANCHES: '$branches',
    SETTLED_KEY: '$settled',
    TIMING: '$timing',
    VALUE: 'value',
} as const;

export type ReservedKey = (typeof ReservedKey)[keyof typeof ReservedKey];

export const STEPS = ReservedKey.STEPS;
export const HISTORY = ReservedKey.HISTORY;
export const SIGNAL = ReservedKey.SIGNAL;
export const CHAIN_ID = ReservedKey.CHAIN_ID;
export const STACK_ID = ReservedKey.STACK_ID;
export const NAMESPACE = ReservedKey.NAMESPACE;
export const SERVICES = ReservedKey.SERVICES;
export const DEPENDENCIES = ReservedKey.DEPENDENCIES;
export const DEPS = ReservedKey.DEPS;
export const VALIDATORS = ReservedKey.VALIDATORS;

export const STACK_ID_KEY = ReservedKey.STACK_ID_KEY;
export const SIGNAL_KEY = ReservedKey.SIGNAL_KEY;
export const NAMESPACE_KEY = ReservedKey.NAMESPACE_KEY;

export const STEP_ID = ReservedKey.STEP_ID;
export const ATTEMPT = ReservedKey.ATTEMPT;
export const RETRY_DELAY = ReservedKey.RETRY_DELAY;
export const IS_DURABLE = ReservedKey.IS_DURABLE;
export const WORKFLOW_ID = ReservedKey.WORKFLOW_ID;
export const BRANCH_SELECTED = ReservedKey.BRANCH_SELECTED;
export const SKIPPED_BRANCHES = ReservedKey.SKIPPED_BRANCHES;
export const SKIPPED = ReservedKey.SKIPPED;
export const BRANCHES = ReservedKey.BRANCHES;
export const SETTLED_KEY = ReservedKey.SETTLED_KEY;
export const TIMING = ReservedKey.TIMING;
export const VALUE = ReservedKey.VALUE;

const CORE_RESERVED_KEYS = new Set<string>([
    ReservedKey.STEPS,
    ReservedKey.HISTORY,
    ReservedKey.SIGNAL,
    ReservedKey.CHAIN_ID,
    ReservedKey.STACK_ID,
    ReservedKey.NAMESPACE,
    ReservedKey.SERVICES,
    ReservedKey.DEPENDENCIES,
    ReservedKey.DEPS,
    ReservedKey.VALIDATORS,
    ReservedKey.STACK_ID_KEY,
    ReservedKey.SIGNAL_KEY,
    ReservedKey.NAMESPACE_KEY,
    ReservedKey.STEP_ID,
]);

export const isReservedKey = (key: string): key is ReservedKey => {
    return CORE_RESERVED_KEYS.has(key);
};
