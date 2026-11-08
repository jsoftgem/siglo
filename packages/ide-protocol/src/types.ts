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

export interface GraphNode {
    id: string; // Deterministic AST node ID (e.g. "step_callStripe_L14_C5")
    name: string; // Display label
    stepKind: 'generic' | 'http' | 'crypto' | 'notification' | 'ai' | 'custom';
    location: SourceRange; // Precise definition range in source
    declarationRange: SourceRange; // Outer enclosing statement range
    specs?: StepSpec[];
    properties?: Record<string, string>; // Static, displayable configuration (never evaluated)
    executionConfig?: {
        retries?: number;
        timeoutMs?: number;
        hasCompensation?: boolean;
    };
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
    properties?: Record<string, string>;
    nodes: GraphNode[];
    edges: GraphEdge[];
    unresolved: UnresolvedNode[];
    diagnostics: Diagnostic[];
    workflows?: WorkflowGraph[];
}
