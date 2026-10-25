export type WorkflowNodeType = 'step' | 'sequence' | 'parallel' | 'branch' | 'wait' | 'map';

export interface BaseWorkflowNode {
    id: string;
    name: string;
    type: WorkflowNodeType;
    metadata?: Record<string, any>;
}

export interface StepNode extends BaseWorkflowNode {
    type: 'step';
    step?: any;
}

export interface SequenceNode extends BaseWorkflowNode {
    type: 'sequence';
    children: WorkflowNode[];
}

export type ParallelMode = 'fail-fast' | 'allSettled' | 'race';
export type MergeStrategyType = 'shallow' | 'deep' | 'error' | ((target: any, source: any, branchKey: string | number) => any);

export interface ParallelNode extends BaseWorkflowNode {
    type: 'parallel';
    branches: WorkflowNode[];
    mode?: ParallelMode;
    mergeStrategy?: MergeStrategyType;
}

export interface BranchNode extends BaseWorkflowNode {
    type: 'branch';
    branches: Record<string, WorkflowNode>;
    selector?: (ctx: any, meta?: any) => string | boolean | Promise<string | boolean>;
    defaultBranch?: string | WorkflowNode;
}

export interface WaitNode extends BaseWorkflowNode {
    type: 'wait';
    eventName?: string;
    correlationKey?: string | ((ctx: any) => string);
    timeoutMs?: number;
    durationMs?: number;
}

export interface MapNode extends BaseWorkflowNode {
    type: 'map';
    items?: any[] | AsyncIterable<any> | ((ctx: any) => any[] | AsyncIterable<any> | Promise<any[] | AsyncIterable<any>>);
    itemNode: WorkflowNode;
    concurrency?: number;
    stopOnError?: boolean;
    preserveOrder?: boolean;
}

export type WorkflowNode =
    | StepNode
    | SequenceNode
    | ParallelNode
    | BranchNode
    | WaitNode
    | MapNode;

export interface GraphValidationResult {
    valid: boolean;
    errors: string[];
}

export interface GraphInspectionEdge {
    from: string;
    to: string;
    label?: string;
}

export interface GraphInspectionResult {
    nodes: Array<{ id: string; name: string; type: WorkflowNodeType; metadata?: any }>;
    edges: GraphInspectionEdge[];
    entryNodeId: string;
    exitNodeIds: string[];
    totalNodes: number;
}
