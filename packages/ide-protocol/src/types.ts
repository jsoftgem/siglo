export interface SourcePosition {
    line: number; // 0-indexed line number
    character: number; // 0-indexed UTF-16 code unit offset
}

export interface SourceRange {
    start: SourcePosition;
    end: SourcePosition;
}

export interface StepSpecRule {
    kind: 'default' | 'required' | 'message' | 'validate' | 'transform' | 'translate' | 'schema' | 'options';
    value: string;
    expression: boolean;
    description?: string;
}

export interface StepSpec {
    field: string; // $root$ denotes a whole-input schema
    rules: StepSpecRule[];
}

export interface HttpEcosystemConfig {
    kind: 'http';
    method?: string;
    url?: string;
    isDynamicUrl?: boolean;
    maxRetries?: number | string;
    retryOnStatus?: number[] | string;
    timeoutMs?: number | string;
    allowNotFound?: boolean | string;
    responseType?: string;
}

export interface CryptoEcosystemConfig {
    kind: 'crypto';
    operation?: string;
    provider?: string;
    algorithm?: string;
    fields?: string[] | string;
    toleranceSeconds?: number | string;
}

export interface NotificationEcosystemConfig {
    kind: 'notification';
    channel?: string;
    isApproval?: boolean;
    approvalExpiresIn?: string | number;
    subject?: string;
    template?: string;
}

export interface AiEcosystemConfig {
    kind: 'ai';
    provider?: string;
    model?: string;
    maxRepairAttempts?: number | string;
    fallbackModels?: string[] | string;
    temperature?: number | string;
    maxTokens?: number | string;
}

export type EcosystemConfig =
    | HttpEcosystemConfig
    | CryptoEcosystemConfig
    | NotificationEcosystemConfig
    | AiEcosystemConfig;

export interface GraphNode {
    id: string; // Deterministic AST node ID (e.g. "step_callStripe_L14_C5")
    name: string; // Display label
    stepKind: 'generic' | 'http' | 'crypto' | 'notification' | 'ai' | 'custom';
    location: SourceRange; // Precise definition range in source (or call/spread site in active document)
    declarationRange: SourceRange; // Outer enclosing statement range
    sourceUri?: string; // Target file URI when defined in a related file
    sourceLocation?: SourceRange; // Precise definition range inside sourceUri
    specs?: StepSpec[];
    properties?: Record<string, string>; // Static, displayable configuration (never evaluated)
    executionConfig?: {
        retries?: number;
        timeoutMs?: number;
        hasCompensation?: boolean;
    };
    ecosystemConfig?: EcosystemConfig;
}

export interface GraphEdge {
    id: string;
    from: string; // Source node ID
    to: string; // Target node ID
    type: 'sequential' | 'parallel' | 'branch' | 'fallback' | 'compensation';
    label?: string; // Optional branch condition label
}

export interface Diagnostic {
    code: string; // e.g. "SIGLO_STATIC_CYCLE", "SIGLO_MISSING_FALLBACK"
    message: string;
    severity: 'error' | 'warning' | 'info';
    range: SourceRange;
    fixAvailable?: boolean;
}

export interface UnresolvedNode {
    id: string;
    reason: 'dynamic-call' | 'external-factory' | 'unsupported-syntax';
    expressionSnippet: string;
    location: SourceRange;
}

export interface WorkflowGraph {
    name: string;
    uri?: string;
    location?: SourceRange;
    properties?: Record<string, string>;
    nodes: GraphNode[];
    edges: GraphEdge[];
    unresolved: UnresolvedNode[];
    diagnostics: Diagnostic[];
}

export interface GraphDocument {
    uri: string;
    documentVersion: number;
    workflowName: string;
    location?: SourceRange;
    properties?: Record<string, string>;
    nodes: GraphNode[];
    edges: GraphEdge[];
    unresolved: UnresolvedNode[];
    diagnostics: Diagnostic[];
    workflows?: WorkflowGraph[];
}
