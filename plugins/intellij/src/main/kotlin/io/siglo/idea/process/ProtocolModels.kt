package io.siglo.idea.process

data class SourcePosition(
    val line: Int,
    val character: Int
)

data class SourceRange(
    val start: SourcePosition,
    val end: SourcePosition
)

data class ExecutionConfig(
    val retries: Int? = null,
    val timeoutMs: Int? = null,
    val hasCompensation: Boolean? = null
)

data class StepSpecRule(
    val kind: String,
    val value: String,
    val expression: Boolean,
    val description: String? = null
)

data class StepSpec(val field: String, val rules: List<StepSpecRule>)

data class ExecutionTarget(val exportName: String, val stepIndex: Int)

data class GraphNode(
    val id: String,
    val name: String,
    val stepKind: String,
    val location: SourceRange,
    val declarationRange: SourceRange,
    val sourceUri: String? = null,
    val sourceLocation: SourceRange? = null,
    val executionConfig: ExecutionConfig? = null,
    val properties: Map<String, String>? = null,
    val specs: List<StepSpec>? = null,
    val executionTarget: ExecutionTarget? = null
)

data class GraphEdge(
    val id: String,
    val from: String,
    val to: String,
    val type: String,
    val label: String? = null
)

data class Diagnostic(
    val code: String,
    val message: String,
    val severity: String,
    val range: SourceRange,
    val fixAvailable: Boolean? = null
)

data class UnresolvedNode(
    val id: String,
    val reason: String,
    val expressionSnippet: String,
    val location: SourceRange
)

data class WorkflowGraph(
    val name: String,
    val uri: String? = null,
    val location: SourceRange? = null,
    val nodes: List<GraphNode> = emptyList(),
    val edges: List<GraphEdge> = emptyList(),
    val unresolved: List<UnresolvedNode> = emptyList(),
    val diagnostics: List<Diagnostic> = emptyList(),
    val properties: Map<String, String>? = null
)

data class GraphDocument(
    val uri: String,
    val documentVersion: Int,
    val workflowName: String,
    val location: SourceRange? = null,
    val nodes: List<GraphNode> = emptyList(),
    val edges: List<GraphEdge> = emptyList(),
    val unresolved: List<UnresolvedNode> = emptyList(),
    val diagnostics: List<Diagnostic> = emptyList(),
    val workflows: List<WorkflowGraph> = emptyList(),
    val properties: Map<String, String>? = null
)

data class DiscoveredWorkflow(
    val id: String,
    val name: String,
    val uri: String,
    val range: SourceRange
)

data class DiscoverWorkflowsResult(
    val workflows: List<DiscoveredWorkflow> = emptyList()
)

data class ResolveLocationResult(
    val nodeId: String? = null,
    val edgeId: String? = null,
    val range: SourceRange? = null
)

data class JsonRpcRequest(
    val jsonrpc: String = "2.0",
    val id: Long,
    val method: String,
    val params: Any?
)

data class JsonRpcError(
    val code: Int,
    val message: String,
    val data: Any? = null
)
