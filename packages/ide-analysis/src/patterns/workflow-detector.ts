import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { GraphDocument, GraphNode, GraphEdge, UnresolvedNode, Diagnostic, SourceRange } from '@siglo/ide-protocol';
import { getSourceRange, generateDeterministicNodeId, toFilePath, normalizeUri } from '../mapper';
import { detectStepFromExpression, DetectedStep, extractDisplayProperties } from './step-detector';
import {
    ModuleMetadata,
    ExportTarget,
    collectModuleMetadata,
    resolveRelativeImportPath,
    findLexicalDeclaration,
    extractFunctionReturnExpressions,
} from './module-resolver';

interface SubflowData {
    nodes: GraphNode[];
    edges: GraphEdge[];
    unresolved?: UnresolvedNode[];
    properties?: Record<string, string>;
}

interface ParseSession {
    fileContexts: Map<string, WorkflowParseContext>;
    resolvingKeys: Set<string>;
    depth: number;
}

interface WorkflowParseContext {
    sourceFile: ts.SourceFile;
    uri: string;
    filePath: string;
    documentVersion: number;
    stepDefinitions: Map<string, GraphNode>;
    flowDefinitions: Map<string, SubflowData>;
    metadata: ModuleMetadata;
    session: ParseSession;
}

const MAX_RESOLVE_DEPTH = 10;
const FLOW_CHAIN_METHODS = new Set(['then', 'parallel', 'branch', 'fallback', 'compensate']);
const FLOW_CONFIG_METHODS = new Set(['timeout', 'version', 'networkPolicy', 'monitor', 'durable', 'saga']);

export function analyzeWorkflowsInSourceFile(
    sourceFile: ts.SourceFile,
    uri: string,
    documentVersion = 1,
): GraphDocument[] {
    const filePath = toFilePath(uri);
    const session: ParseSession = {
        fileContexts: new Map(),
        resolvingKeys: new Set(),
        depth: 0,
    };
    const ctx = createWorkflowContext(sourceFile, uri, filePath, documentVersion, session);
    if (filePath) {
        session.fileContexts.set(path.resolve(filePath), ctx);
    }

    // Phase 1: Collect step variable declarations
    collectStepDefinitions(sourceFile, ctx);

    // Phase 2: Find workflow declarations and chains
    const workflows: GraphDocument[] = [];
    walkForWorkflows(sourceFile, ctx, workflows);

    // Fallback: If no workflow call expression was found, but steps exist in file,
    // create a default synthetic workflow document representing the file's steps.
    if (workflows.length === 0 && ctx.stepDefinitions.size > 0) {
        const nodes = Array.from(ctx.stepDefinitions.values());
        const edges: GraphEdge[] = [];
        for (let i = 0; i < nodes.length - 1; i++) {
            edges.push({
                id: `edge_${nodes[i].id}_to_${nodes[i + 1].id}`,
                from: nodes[i].id,
                to: nodes[i + 1].id,
                type: 'sequential',
            });
        }
        workflows.push({
            uri,
            documentVersion,
            workflowName: 'defaultWorkflow',
            ...(nodes[0]?.location ? { location: nodes[0].location } : {}),
            nodes,
            edges,
            unresolved: [],
            diagnostics: runDiagnostics(nodes, edges),
        });
    }

    return workflows;
}

function createWorkflowContext(
    sourceFile: ts.SourceFile,
    uri: string,
    filePath: string,
    documentVersion: number,
    session: ParseSession,
): WorkflowParseContext {
    return {
        sourceFile,
        uri,
        filePath,
        documentVersion,
        stepDefinitions: new Map(),
        flowDefinitions: new Map(),
        metadata: collectModuleMetadata(sourceFile),
        session,
    };
}

function getScriptKindForFile(filePath: string): ts.ScriptKind {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.tsx') return ts.ScriptKind.TSX;
    if (ext === '.jsx') return ts.ScriptKind.JSX;
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
}

function getOrLoadFileContext(filePath: string, session: ParseSession): WorkflowParseContext | null {
    const resolved = path.resolve(filePath);
    const cached = session.fileContexts.get(resolved);
    if (cached) return cached;

    let content: string;
    try {
        content = fs.readFileSync(resolved, 'utf-8');
    } catch {
        return null;
    }

    const sourceFile = ts.createSourceFile(
        resolved,
        content,
        ts.ScriptTarget.Latest,
        true,
        getScriptKindForFile(resolved),
    );
    const ctx = createWorkflowContext(sourceFile, normalizeUri(resolved), resolved, 1, session);
    session.fileContexts.set(resolved, ctx);
    collectStepDefinitions(sourceFile, ctx);
    walkForWorkflows(sourceFile, ctx, []);
    return ctx;
}

function collectStepDefinitions(sourceFile: ts.SourceFile, ctx: WorkflowParseContext) {
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.initializer) {
            const varName = node.name.getText(sourceFile);
            const enclosingRange = getSourceRange(sourceFile, node);
            const detected = detectStepFromExpression(node.initializer, sourceFile, enclosingRange);
            if (detected && detected.kind === 'node') {
                const stepNode = {
                    ...detected.node,
                    declarationRange: enclosingRange,
                };
                ctx.stepDefinitions.set(varName, stepNode);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
}

function getEnclosingName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
    let p: ts.Node | undefined = node.parent;
    while (p) {
        if (ts.isVariableDeclaration(p)) {
            return p.name.getText(sourceFile);
        }
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            return p.left.getText(sourceFile);
        }
        if (ts.isPropertyAssignment(p)) {
            return p.name.getText(sourceFile).replace(/['"]/g, '');
        }
        if (ts.isExportAssignment(p)) {
            return 'default';
        }
        if (ts.isSourceFile(p) || ts.isBlock(p)) break;
        p = p.parent;
    }
    return null;
}

function isOutermostFlowCall(callExpr: ts.CallExpression): boolean {
    const p = callExpr.parent;
    if (p && ts.isPropertyAccessExpression(p)) {
        const grandP = p.parent;
        if (grandP && ts.isCallExpression(grandP) && grandP.expression === p) {
            return false;
        }
    }
    return true;
}

function walkForWorkflows(node: ts.Node, ctx: WorkflowParseContext, outWorkflows: GraphDocument[]) {
    if (ts.isCallExpression(node)) {
        if (isOutermostFlowCall(node)) {
            const rootFlow = findRootFlowCall(node, ctx.sourceFile);
            if (!rootFlow) {
                let receiver: ts.Expression = node;
                const configuration: ts.CallExpression[] = [];
                while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
                    configuration.unshift(receiver);
                    receiver = receiver.expression.expression;
                }
                if (ts.isIdentifier(receiver)) {
                    const definition = ctx.flowDefinitions.get(receiver.text);
                    if (definition?.properties)
                        for (const call of configuration) {
                            const method = (call.expression as ts.PropertyAccessExpression).name.text;
                            applyFlowProperty(definition.properties, method, [...call.arguments], ctx.sourceFile);
                        }
                }
            }
            if (rootFlow) {
                // Inline flows are expanded by their enclosing combinator/flow. They
                // must not become a separate workflow named after the outer variable.
                let ancestor: ts.Node | undefined = node.parent;
                while (ancestor && !ts.isStatement(ancestor) && !ts.isVariableDeclaration(ancestor)) {
                    if (ts.isCallExpression(ancestor)) {
                        const callee = ancestor.expression;
                        const name = ts.isIdentifier(callee)
                            ? callee.text
                            : ts.isPropertyAccessExpression(callee)
                              ? callee.name.text
                              : '';
                        if (
                            ['flow', 'pipe', 'parallel', 'all', 'allSettled', 'race', 'map', 'when', 'branch'].includes(
                                name,
                            )
                        )
                            return;
                    }
                    ancestor = ancestor.parent;
                }
                const doc = parseWorkflowChain(node, rootFlow, ctx);
                if (doc && !outWorkflows.some(w => w.workflowName === doc.workflowName)) {
                    outWorkflows.push(doc);
                    if (doc.workflowName) {
                        const definition = { nodes: doc.nodes, edges: doc.edges, properties: doc.properties };
                        ctx.flowDefinitions.set(doc.workflowName, definition);
                        const variableName = getEnclosingName(node, ctx.sourceFile);
                        if (variableName) ctx.flowDefinitions.set(variableName, definition);
                    }
                }
            }
        }
    }
    ts.forEachChild(node, child => walkForWorkflows(child, ctx, outWorkflows));
}

function findRootFlowCall(
    callExpr: ts.CallExpression,
    sourceFile: ts.SourceFile,
): { call: ts.CallExpression; name: string } | null {
    let curr: ts.Expression = callExpr;
    let rootCall: ts.CallExpression | null = null;

    while (curr) {
        if (ts.isCallExpression(curr)) {
            const expr = curr.expression;
            if (
                ts.isIdentifier(expr) &&
                (expr.text === 'flow' || expr.text === 'workflow' || expr.text === 'pipe' || expr.text === 'Pipeline')
            ) {
                rootCall = curr;
                break;
            }
            if (
                ts.isPropertyAccessExpression(expr) &&
                ['Step', 'Func', 'Chain'].includes(expr.expression.getText(sourceFile)) &&
                ['flow', 'pipe'].includes(expr.name.text)
            ) {
                rootCall = curr;
                break;
            }
            if (ts.isPropertyAccessExpression(expr)) {
                curr = expr.expression;
                continue;
            }
            break;
        } else if (ts.isPropertyAccessExpression(curr)) {
            curr = curr.expression;
        } else {
            break;
        }
    }

    if (rootCall) {
        let name = '';
        const firstArg = rootCall.arguments[0];
        if (firstArg) {
            if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
                name = firstArg.text;
            } else if (ts.isObjectLiteralExpression(firstArg)) {
                for (const prop of firstArg.properties) {
                    if (
                        ts.isPropertyAssignment(prop) &&
                        prop.name.getText(sourceFile).replace(/['"]/g, '') === 'name' &&
                        (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
                    ) {
                        name = prop.initializer.text;
                    }
                }
            }
        }

        if (!name) {
            const enclosingName = getEnclosingName(callExpr, sourceFile);
            if (enclosingName) {
                name = enclosingName;
            } else {
                const argNames = rootCall.arguments.map(a => a.getText(sourceFile)).join(', ');
                name = argNames ? `flow(${argNames})` : 'workflow';
            }
        }

        return { call: rootCall, name };
    }

    return null;
}

interface MethodCall {
    methodName: string;
    args: ts.Expression[];
    callExpr: ts.CallExpression;
}

function unwrapTransparent(expr: ts.Expression): ts.Expression {
    let curr = expr;
    while (
        ts.isParenthesizedExpression(curr) ||
        ts.isAsExpression(curr) ||
        ts.isTypeAssertionExpression(curr) ||
        ts.isNonNullExpression(curr) ||
        ts.isSatisfiesExpression(curr)
    ) {
        curr = curr.expression;
    }
    return curr;
}

function resolveFunctionLikeFromDecl(
    node: ts.FunctionDeclaration | ts.VariableDeclaration | ts.Expression,
): ts.FunctionLikeDeclaration | null {
    if (ts.isFunctionDeclaration(node)) return node;
    const expr = ts.isVariableDeclaration(node) ? node.initializer : node;
    if (!expr) return null;
    const unwrapped = unwrapTransparent(expr);
    if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
        return unwrapped;
    }
    return null;
}

function resolveExportTarget(
    targetCtx: WorkflowParseContext,
    exportName: string,
    session: ParseSession,
    visitedExports = new Set<string>(),
): { ctx: WorkflowParseContext; target: ExportTarget } | null {
    const key = `${targetCtx.filePath}::${exportName}`;
    if (visitedExports.has(key)) return null;
    visitedExports.add(key);

    const direct = targetCtx.metadata.exports.get(exportName);
    if (direct) {
        if (direct.kind === 'local') {
            const decl = targetCtx.metadata.declarations.get(direct.localName);
            return decl ? { ctx: targetCtx, target: { kind: 'declaration', node: decl } } : null;
        }
        if (direct.kind === 'reexport') {
            const nextPath = resolveRelativeImportPath(targetCtx.filePath, direct.specifier);
            const nextCtx = nextPath ? getOrLoadFileContext(nextPath, session) : null;
            return nextCtx ? resolveExportTarget(nextCtx, direct.importedName, session, visitedExports) : null;
        }
        return { ctx: targetCtx, target: direct };
    }

    for (const specifier of targetCtx.metadata.starExports) {
        const nextPath = resolveRelativeImportPath(targetCtx.filePath, specifier);
        const nextCtx = nextPath ? getOrLoadFileContext(nextPath, session) : null;
        if (nextCtx) {
            const found = resolveExportTarget(nextCtx, exportName, session, visitedExports);
            if (found) return found;
        }
    }

    return null;
}

function remapSubflowToCallSite(
    subflow: SubflowData,
    callSiteRange: SourceRange,
    targetCtx: WorkflowParseContext,
    callerCtx: WorkflowParseContext,
): SubflowData {
    if (targetCtx.filePath === callerCtx.filePath) {
        return subflow;
    }
    const relPath =
        path.relative(path.dirname(callerCtx.filePath), targetCtx.filePath).replace(/\\/g, '/') ||
        path.basename(targetCtx.filePath);
    const idMap = new Map<string, string>();
    const usedIds = new Set<string>();

    const nextUniqueId = (baseId: string): string => {
        let candidate = baseId;
        let counter = 2;
        while (usedIds.has(candidate)) {
            candidate = `${baseId}_${counter++}`;
        }
        usedIds.add(candidate);
        return candidate;
    };

    const nodes: GraphNode[] = subflow.nodes.map(node => {
        const baseId = generateDeterministicNodeId(node.name, callSiteRange);
        const newId = nextUniqueId(baseId);
        idMap.set(node.id, newId);
        return {
            ...node,
            id: newId,
            location: callSiteRange,
            declarationRange: callSiteRange,
            sourceUri: node.sourceUri || targetCtx.uri,
            sourceLocation: node.sourceLocation || node.location,
            properties: {
                ...node.properties,
                importedFrom: node.properties?.importedFrom || `${relPath}:${node.location.start.line + 1}`,
            },
        };
    });

    const unresolved: UnresolvedNode[] = (subflow.unresolved || []).map(un => {
        const baseId = `unresolved_L${callSiteRange.start.line + 1}_C${callSiteRange.start.character + 1}`;
        const newId = nextUniqueId(baseId);
        idMap.set(un.id, newId);
        return {
            ...un,
            id: newId,
            location: callSiteRange,
        };
    });

    const edges: GraphEdge[] = subflow.edges.map(edge => ({
        ...edge,
        from: idMap.get(edge.from) || edge.from,
        to: idMap.get(edge.to) || edge.to,
    }));

    return {
        nodes,
        edges,
        ...(unresolved.length ? { unresolved } : {}),
    };
}

function resolveSubflowEntryAndExitIds(subflow: SubflowData): { entryIds: string[]; exitIds: string[] } {
    const allIds = [...subflow.nodes.map(n => n.id), ...(subflow.unresolved || []).map(u => u.id)];
    if (allIds.length === 0) return { entryIds: [], exitIds: [] };
    const idSet = new Set(allIds);
    const hasIncoming = new Set<string>();
    const hasOutgoing = new Set<string>();
    for (const edge of subflow.edges) {
        if (edge.type === 'compensation') continue;
        if (idSet.has(edge.from) && idSet.has(edge.to)) {
            hasIncoming.add(edge.to);
            hasOutgoing.add(edge.from);
        }
    }
    const entryIds = allIds.filter(id => !hasIncoming.has(id));
    const exitIds = allIds.filter(id => !hasOutgoing.has(id));
    return {
        entryIds: entryIds.length > 0 ? entryIds : [allIds[0]],
        exitIds: exitIds.length > 0 ? exitIds : [allIds[allIds.length - 1]],
    };
}

function parseWorkflowChain(
    outerCall: ts.CallExpression,
    rootFlow: { call: ts.CallExpression; name: string },
    ctx: WorkflowParseContext,
): GraphDocument | null {
    // Collect the chain of calls from inner rootFlow to outerCall
    const chain: MethodCall[] = [];
    let curr: ts.Expression = outerCall;

    while (curr && curr !== rootFlow.call) {
        if (ts.isCallExpression(curr)) {
            const expr = curr.expression;
            if (ts.isPropertyAccessExpression(expr)) {
                chain.unshift({
                    methodName: expr.name.text,
                    args: Array.from(curr.arguments),
                    callExpr: curr,
                });
                curr = expr.expression;
                continue;
            }
            break;
        } else if (ts.isPropertyAccessExpression(curr)) {
            curr = curr.expression;
        } else {
            break;
        }
    }

    return buildWorkflowDocument(
        rootFlow.name,
        Array.from(rootFlow.call.arguments).filter(
            arg =>
                !ts.isStringLiteral(arg) &&
                !ts.isNoSubstitutionTemplateLiteral(arg) &&
                !ts.isObjectLiteralExpression(arg),
        ),
        chain,
        ctx,
        undefined,
        getSourceRange(ctx.sourceFile, outerCall),
    );
}

function buildWorkflowDocument(
    workflowName: string,
    initialExpressions: ts.Expression[],
    chain: MethodCall[],
    ctx: WorkflowParseContext,
    seedSubflow?: SubflowData,
    workflowLocation?: SourceRange,
): GraphDocument {
    const properties: Record<string, string> = { ...(seedSubflow?.properties || {}) };
    const nodes: GraphNode[] = [...(seedSubflow?.nodes || [])];
    const edges: GraphEdge[] = [...(seedSubflow?.edges || [])];
    const unresolved: UnresolvedNode[] = [...(seedSubflow?.unresolved || [])];
    const stepInvocations: { id: string; name: string; location: SourceRange; usageLocation?: SourceRange }[] = [];
    let currentHeadIds: string[] = seedSubflow ? resolveSubflowEntryAndExitIds(seedSubflow).exitIds : [];

    function addNode(detected: DetectedStep, usageNode?: ts.Node): string {
        if (detected.kind === 'node') {
            let nodeToAdd = detected.node;
            // If referencing a known definition, merge definition range (preferring lexical scope)
            if (detected.variableName) {
                let def: GraphNode | undefined;
                if (usageNode) {
                    const lexical = findLexicalDeclaration(detected.variableName, usageNode, ctx.metadata.declarations);
                    if (lexical && ts.isVariableDeclaration(lexical) && lexical.initializer) {
                        const enclosingRange = getSourceRange(ctx.sourceFile, lexical);
                        const lexicalDetected = detectStepFromExpression(
                            lexical.initializer,
                            ctx.sourceFile,
                            enclosingRange,
                        );
                        if (lexicalDetected?.kind === 'node') {
                            def = { ...lexicalDetected.node, declarationRange: enclosingRange };
                        }
                    }
                }
                if (!def) {
                    def = ctx.stepDefinitions.get(detected.variableName);
                }
                if (def) {
                    nodeToAdd = {
                        ...nodeToAdd,
                        id: def.id,
                        name: def.name,
                        stepKind: def.stepKind,
                        location: def.location,
                        declarationRange: def.declarationRange,
                        executionConfig: { ...def.executionConfig, ...nodeToAdd.executionConfig },
                        properties: { ...def.properties, ...nodeToAdd.properties },
                        specs: [...(def.specs || []), ...(nodeToAdd.specs || [])],
                        ecosystemConfig: def.ecosystemConfig || nodeToAdd.ecosystemConfig,
                    };
                }
            }
            const usageLoc = usageNode ? getSourceRange(ctx.sourceFile, usageNode) : undefined;
            stepInvocations.push({
                id: nodeToAdd.id,
                name: nodeToAdd.name,
                location: nodeToAdd.location,
                usageLocation: usageLoc,
            });
            // Check if already in nodes
            const existing = nodes.find(n => n.id === nodeToAdd.id);
            if (!existing) {
                nodes.push(nodeToAdd);
            }
            return nodeToAdd.id;
        } else {
            unresolved.push(detected.unresolved);
            return detected.unresolved.id;
        }
    }

    function appendSubflow(subflow: SubflowData) {
        const subUnresolved = subflow.unresolved || [];
        if (subflow.nodes.length === 0 && subUnresolved.length === 0) return;

        for (const n of subflow.nodes) {
            stepInvocations.push({
                id: n.id,
                name: n.name,
                location: n.location,
            });
            if (!nodes.some(existing => existing.id === n.id)) {
                nodes.push(n);
            }
        }
        for (const u of subUnresolved) {
            if (!unresolved.some(existing => existing.id === u.id)) {
                unresolved.push(u);
            }
        }
        for (const e of subflow.edges) {
            if (!edges.some(existing => existing.id === e.id)) {
                edges.push(e);
            }
        }

        const { entryIds, exitIds } = resolveSubflowEntryAndExitIds(subflow);
        for (const headId of currentHeadIds) {
            for (const entryId of entryIds) {
                edges.push({
                    id: `edge_${headId}_to_${entryId}_${edges.length}`,
                    from: headId,
                    to: entryId,
                    type: 'sequential',
                });
            }
        }

        currentHeadIds = exitIds;
    }

    function connect(from: string[], to: string, type: GraphEdge['type'] = 'sequential', label?: string) {
        for (const id of new Set(from))
            edges.push({
                id: `edge_${id}_to_${to}_${type}_${edges.length}`,
                from: id,
                to,
                type,
                ...(label ? { label } : {}),
            });
    }

    function junction(expr: ts.Expression, name: string, suffix: string): string {
        const location = getSourceRange(ctx.sourceFile, expr);
        const id = generateDeterministicNodeId(`${name}_${suffix}`, location);
        nodes.push({ id, name, stepKind: 'custom', location, declarationRange: location });
        return id;
    }

    // Expand combinators before step detection: their arguments are graph fragments,
    // and options objects are metadata rather than executable steps.
    function appendExpression(rawExpr: ts.Expression, resolving = new Set<string>()) {
        const expr = unwrapTransparent(rawExpr);
        const exprRange = getSourceRange(ctx.sourceFile, rawExpr);

        if (ts.isSpreadElement(expr)) {
            const subflow = resolveExpandableExpression(expr.expression, ctx, exprRange, resolving, false);
            if (subflow) {
                appendSubflow(subflow);
                return;
            }
        }
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'steps') {
            const subflow = resolveExpandableExpression(expr.expression, ctx, exprRange, resolving, false);
            if (subflow) {
                appendSubflow(subflow);
                return;
            }
        }
        if (ts.isIdentifier(expr)) {
            const definition = findCombinatorDefinition(expr.text);
            if (definition && !resolving.has(expr.text)) {
                appendExpression(definition, new Set([...resolving, expr.text]));
                return;
            }
            if (ctx.flowDefinitions.has(expr.text)) {
                appendSubflow(ctx.flowDefinitions.get(expr.text)!);
                return;
            }
            const subflow = resolveExpandableExpression(expr, ctx, exprRange, resolving, false);
            if (subflow) {
                appendSubflow(subflow);
                return;
            }
        }
        if (ts.isArrayLiteralExpression(expr)) {
            for (const child of expr.elements) appendExpression(child, resolving);
            return;
        }
        if (ts.isCallExpression(expr)) {
            const callee = expr.expression;
            const kind = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee) &&
                    ['Step', 'Func', 'Chain'].includes(callee.expression.getText(ctx.sourceFile))
                  ? callee.name.text
                  : '';
            if (['parallel', 'all', 'race', 'allSettled', 'branch', 'when', 'map'].includes(kind)) {
                const fork = junction(expr, kind, 'fork');
                const forkNode = nodes.find(n => n.id === fork)!;
                forkNode.properties = { operation: kind };
                for (const arg of expr.arguments)
                    if (ts.isObjectLiteralExpression(arg))
                        Object.assign(forkNode.properties, extractDisplayProperties(arg, ctx.sourceFile));
                if (kind === 'when' || kind === 'branch')
                    forkNode.properties.selector = expr.arguments[0]?.getText(ctx.sourceFile) || 'context route';
                if (kind === 'map') forkNode.properties.items = expr.arguments[0]?.getText(ctx.sourceFile) || 'unknown';
                connect(currentHeadIds, fork);
                const exits: string[] = [];
                const alternatives: { expression?: ts.Expression; subflow?: SubflowData; label?: string }[] = [];
                const pushParallelChild = (child: ts.Expression) => {
                    const unwrappedChild = unwrapTransparent(child);
                    if (ts.isSpreadElement(unwrappedChild)) {
                        const spreadSubflow = resolveExpandableExpression(
                            unwrappedChild.expression,
                            ctx,
                            getSourceRange(ctx.sourceFile, unwrappedChild),
                            resolving,
                            false,
                        );
                        if (spreadSubflow) {
                            const onlySequential = spreadSubflow.edges.every(e => e.type === 'sequential');
                            if (onlySequential && spreadSubflow.nodes.length > 0 && !spreadSubflow.unresolved?.length) {
                                for (const stepNode of spreadSubflow.nodes) {
                                    alternatives.push({ subflow: { nodes: [stepNode], edges: [] } });
                                }
                            } else {
                                alternatives.push({ subflow: spreadSubflow });
                            }
                            return;
                        }
                    }
                    alternatives.push({ expression: child });
                };
                if (kind === 'branch') {
                    const mapIndex = expr.arguments[0] && ts.isObjectLiteralExpression(expr.arguments[0]) ? 0 : 1;
                    const map = expr.arguments[mapIndex];
                    if (map && ts.isObjectLiteralExpression(map)) {
                        for (const property of map.properties) {
                            if (ts.isPropertyAssignment(property))
                                alternatives.push({
                                    expression: property.initializer,
                                    label: property.name.getText(ctx.sourceFile).replace(/['"]/g, ''),
                                });
                            else if (ts.isShorthandPropertyAssignment(property))
                                alternatives.push({ expression: property.name, label: property.name.text });
                        }
                    }
                    const fallback = expr.arguments[mapIndex + 1];
                    if (fallback) alternatives.push({ expression: fallback, label: 'default' });
                } else if (kind === 'when') {
                    if (expr.arguments[1]) alternatives.push({ expression: expr.arguments[1], label: 'then' });
                    if (expr.arguments[2]) alternatives.push({ expression: expr.arguments[2], label: 'else' });
                    else exits.push(fork); // False predicate skips the then path.
                } else if (kind === 'map') {
                    if (expr.arguments[1]) alternatives.push({ expression: expr.arguments[1], label: 'each item' });
                } else {
                    for (const arg of expr.arguments) {
                        if (ts.isObjectLiteralExpression(arg)) continue;
                        for (const child of ts.isArrayLiteralExpression(arg) ? arg.elements : [arg])
                            pushParallelChild(child);
                    }
                }
                for (const alternative of alternatives) {
                    currentHeadIds = [fork];
                    const edgeStart = edges.length;
                    if (alternative.subflow) {
                        appendSubflow(alternative.subflow);
                    } else if (alternative.expression) {
                        appendExpression(alternative.expression, resolving);
                    }
                    for (const edge of edges.slice(edgeStart))
                        if (edge.from === fork) {
                            edge.type = kind === 'branch' || kind === 'when' ? 'branch' : 'parallel';
                            edge.label = alternative.label || kind;
                        }
                    exits.push(...currentHeadIds);
                }
                const join = junction(expr, `${kind} join`, 'join');
                connect(exits.length ? exits : [fork], join);
                currentHeadIds = [join];
                return;
            }
            if (['flow', 'workflow', 'pipe', 'Pipeline'].includes(kind)) {
                for (const child of expr.arguments) {
                    if (!ts.isStringLiteral(child) && !ts.isObjectLiteralExpression(child))
                        appendExpression(child, resolving);
                }
                return;
            }
            const resolvedCall = resolveExpandableExpression(expr, ctx, exprRange, resolving, false);
            if (resolvedCall) {
                appendSubflow(resolvedCall);
                return;
            }
        }
        if (ts.isPropertyAccessExpression(expr)) {
            const resolvedProp = resolveExpandableExpression(expr, ctx, exprRange, resolving, false);
            if (resolvedProp) {
                appendSubflow(resolvedProp);
                return;
            }
        }
        const detected = detectStepFromExpression(expr, ctx.sourceFile);
        if (detected) {
            const id = addNode(detected, expr);
            connect(currentHeadIds, id);
            currentHeadIds = [id];
        }
    }

    function findCombinatorDefinition(name: string): ts.Expression | undefined {
        let result: ts.Expression | undefined;
        function visit(node: ts.Node) {
            if (
                ts.isVariableDeclaration(node) &&
                node.name.getText(ctx.sourceFile) === name &&
                node.initializer &&
                ts.isCallExpression(node.initializer) &&
                ['parallel', 'all', 'race', 'allSettled', 'branch', 'when', 'map'].includes(
                    ts.isIdentifier(node.initializer.expression)
                        ? node.initializer.expression.text
                        : ts.isPropertyAccessExpression(node.initializer.expression) &&
                            ['Step', 'Func', 'Chain'].includes(
                                node.initializer.expression.expression.getText(ctx.sourceFile),
                            )
                          ? node.initializer.expression.name.text
                          : '',
                )
            )
                result = node.initializer;
            ts.forEachChild(node, visit);
        }
        visit(ctx.sourceFile);
        return result;
    }

    for (const arg of initialExpressions) {
        appendExpression(arg);
    }

    // 2. Process chained methods (.then, .parallel, .branch, .fallback, .compensate)
    for (const item of chain) {
        const { methodName, args } = item;
        applyFlowProperty(properties, methodName, args, ctx.sourceFile);
        if (methodName === 'then') {
            for (const arg of args) appendExpression(arg);
        } else if (methodName === 'parallel') {
            const arg = args[0];
            const nextHeadIds: string[] = [];
            if (arg && ts.isArrayLiteralExpression(arg)) {
                for (const el of arg.elements) {
                    if (ts.isIdentifier(el) && ctx.flowDefinitions.has(el.text)) {
                        const sub = ctx.flowDefinitions.get(el.text)!;
                        if (sub.nodes.length > 0) {
                            for (const n of sub.nodes) {
                                if (!nodes.some(existing => existing.id === n.id)) nodes.push(n);
                            }
                            for (const e of sub.edges) {
                                if (!edges.some(existing => existing.id === e.id)) edges.push(e);
                            }
                            const { entryIds, exitIds } = resolveSubflowEntryAndExitIds(sub);
                            for (const headId of currentHeadIds) {
                                for (const entryId of entryIds) {
                                    edges.push({
                                        id: `edge_${headId}_to_${entryId}_parallel`,
                                        from: headId,
                                        to: entryId,
                                        type: 'parallel',
                                    });
                                }
                            }
                            nextHeadIds.push(...exitIds);
                        }
                        continue;
                    }

                    const detected = detectStepFromExpression(el, ctx.sourceFile);
                    if (detected) {
                        const nextId = addNode(detected, el);
                        nextHeadIds.push(nextId);
                        for (const headId of currentHeadIds) {
                            edges.push({
                                id: `edge_${headId}_to_${nextId}_parallel`,
                                from: headId,
                                to: nextId,
                                type: 'parallel',
                            });
                        }
                    }
                }
            }
            if (nextHeadIds.length > 0) {
                currentHeadIds = nextHeadIds;
            }
        } else if (methodName === 'branch') {
            const conditionExpr = args[0];
            const trueArg = args[1];
            const falseArg = args[2];
            const conditionLabel = conditionExpr ? conditionExpr.getText(ctx.sourceFile) : undefined;
            const nextHeadIds: string[] = [];

            if (trueArg) {
                const detected = detectStepFromExpression(trueArg, ctx.sourceFile);
                if (detected) {
                    const trueId = addNode(detected, trueArg);
                    nextHeadIds.push(trueId);
                    for (const headId of currentHeadIds) {
                        edges.push({
                            id: `edge_${headId}_to_${trueId}_branch_true`,
                            from: headId,
                            to: trueId,
                            type: 'branch',
                            label: conditionLabel ? `true: ${conditionLabel}` : 'true',
                        });
                    }
                }
            }

            if (falseArg) {
                const detected = detectStepFromExpression(falseArg, ctx.sourceFile);
                if (detected) {
                    const falseId = addNode(detected, falseArg);
                    nextHeadIds.push(falseId);
                    for (const headId of currentHeadIds) {
                        edges.push({
                            id: `edge_${headId}_to_${falseId}_branch_false`,
                            from: headId,
                            to: falseId,
                            type: 'branch',
                            label: conditionLabel ? `false: !(${conditionLabel})` : 'false',
                        });
                    }
                }
            }

            if (nextHeadIds.length > 0) {
                currentHeadIds = nextHeadIds;
            }
        } else if (methodName === 'fallback') {
            const arg = args[0];
            if (arg) {
                const detected = detectStepFromExpression(arg, ctx.sourceFile);
                if (detected) {
                    const fallbackId = addNode(detected, arg);
                    for (const headId of currentHeadIds) {
                        edges.push({
                            id: `edge_${headId}_to_${fallbackId}_fallback`,
                            from: headId,
                            to: fallbackId,
                            type: 'fallback',
                        });
                    }
                    currentHeadIds.push(fallbackId);
                }
            }
        } else if (methodName === 'compensate') {
            const arg = args[0];
            if (arg) {
                const detected = detectStepFromExpression(arg, ctx.sourceFile);
                if (detected) {
                    const compId = addNode(detected, arg);
                    for (const headId of currentHeadIds) {
                        edges.push({
                            id: `edge_${headId}_to_${compId}_comp`,
                            from: headId,
                            to: compId,
                            type: 'compensation',
                        });
                    }
                }
            }
        }
    }

    // Process step-level compensations (e.g. step.compensate(stepRefund))
    for (const node of [...nodes]) {
        if (node.executionConfig?.hasCompensation && node.properties?.compensationStep) {
            const compTargetName = node.properties.compensationStep;
            const hasEdge = edges.some(e => e.from === node.id && e.type === 'compensation');
            if (!hasEdge) {
                let compNode = nodes.find(n => n.name === compTargetName || n.id === compTargetName);
                if (!compNode && ctx.stepDefinitions.has(compTargetName)) {
                    compNode = ctx.stepDefinitions.get(compTargetName);
                    if (compNode && !nodes.some(n => n.id === compNode!.id)) {
                        nodes.push(compNode);
                    }
                }
                if (compNode) {
                    edges.push({
                        id: `edge_${node.id}_to_${compNode.id}_comp`,
                        from: node.id,
                        to: compNode.id,
                        type: 'compensation',
                    });
                }
            }
        }
    }

    const routeEdges = new Map<string, GraphEdge>();
    const normalizedEdges: GraphEdge[] = [];
    for (const edge of edges) {
        const key = JSON.stringify([edge.from, edge.to, edge.type]);
        const existing = routeEdges.get(key);
        if (existing) {
            if (edge.label && edge.label !== existing.label)
                existing.label = existing.label ? `${existing.label} / ${edge.label}` : edge.label;
        } else {
            const normalized = {
                ...edge,
                id: `edge_${normalizedEdges.length}_${edge.from}_to_${edge.to}_${edge.type}`,
            };
            routeEdges.set(key, normalized);
            normalizedEdges.push(normalized);
        }
    }
    const diagnostics = runDiagnostics(nodes, normalizedEdges, workflowName, properties);

    return {
        uri: ctx.uri,
        documentVersion: ctx.documentVersion,
        workflowName,
        ...(workflowLocation ? { location: workflowLocation } : {}),
        properties,
        nodes,
        edges: normalizedEdges,
        unresolved,
        diagnostics,
    };
}

function resolveExpressionToSingleStep(expr: ts.Expression, ctx: WorkflowParseContext): SubflowData | null {
    const detected = detectStepFromExpression(expr, ctx.sourceFile);
    if (detected?.kind === 'node') {
        return { nodes: [detected.node], edges: [] };
    }
    return null;
}

function resolveExportedTargetToSubflow(
    targetCtx: WorkflowParseContext,
    target: ExportTarget,
    callSiteRange: SourceRange,
    callerCtx: WorkflowParseContext,
    resolving: Set<string>,
): SubflowData | null {
    if (target.kind === 'expression') {
        const subflow = resolveExpandableExpression(
            target.expr,
            targetCtx,
            getSourceRange(targetCtx.sourceFile, target.expr),
            resolving,
            true,
        );
        return subflow ? remapSubflowToCallSite(subflow, callSiteRange, targetCtx, callerCtx) : null;
    }
    if (target.kind === 'declaration') {
        if (ts.isVariableDeclaration(target.node) && target.node.initializer) {
            const subflow = resolveExpandableExpression(
                target.node.initializer,
                targetCtx,
                getSourceRange(targetCtx.sourceFile, target.node.initializer),
                resolving,
                true,
            );
            return subflow ? remapSubflowToCallSite(subflow, callSiteRange, targetCtx, callerCtx) : null;
        }
    }
    return null;
}

function resolveFunctionCallToSubflow(
    fn: ts.FunctionLikeDeclaration,
    targetCtx: WorkflowParseContext,
    callSiteRange: SourceRange,
    callerCtx: WorkflowParseContext,
): SubflowData | null {
    const { session } = callerCtx;
    if (session.depth >= MAX_RESOLVE_DEPTH) return null;
    const key = `fn:${targetCtx.filePath}:${fn.pos}`;
    if (session.resolvingKeys.has(key)) return null;

    session.resolvingKeys.add(key);
    session.depth += 1;
    try {
        const returns = extractFunctionReturnExpressions(fn);
        for (let i = returns.length - 1; i >= 0; i--) {
            const retExpr = returns[i];
            const retRange = getSourceRange(targetCtx.sourceFile, retExpr);
            const subflow = resolveExpandableExpression(retExpr, targetCtx, retRange, new Set(), true);
            if (subflow && (subflow.nodes.length > 0 || (subflow.unresolved?.length ?? 0) > 0)) {
                return remapSubflowToCallSite(subflow, callSiteRange, targetCtx, callerCtx);
            }
        }
        return null;
    } finally {
        session.depth -= 1;
        session.resolvingKeys.delete(key);
    }
}

function resolveExpandableExpression(
    rawExpr: ts.Expression,
    ctx: WorkflowParseContext,
    callSiteRange: SourceRange,
    resolving: Set<string>,
    allowSingleStep = false,
): SubflowData | null {
    const expr = unwrapTransparent(rawExpr);

    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'steps') {
        return resolveExpandableExpression(expr.expression, ctx, callSiteRange, resolving, allowSingleStep);
    }

    if (ts.isArrayLiteralExpression(expr)) {
        const doc = buildWorkflowDocument('array', Array.from(expr.elements), [], ctx);
        return doc.nodes.length > 0 || doc.unresolved.length > 0
            ? { nodes: doc.nodes, edges: doc.edges, unresolved: doc.unresolved }
            : null;
    }

    if (ts.isIdentifier(expr)) {
        if (ctx.flowDefinitions.has(expr.text)) {
            return ctx.flowDefinitions.get(expr.text)!;
        }
        const localDecl = findLexicalDeclaration(expr.text, expr, ctx.metadata.declarations);
        if (localDecl) {
            if (ts.isVariableDeclaration(localDecl) && localDecl.initializer) {
                const key = `var:${ctx.filePath}:${localDecl.pos}`;
                if (resolving.has(key)) return null;
                if (
                    !allowSingleStep &&
                    detectStepFromExpression(localDecl.initializer, ctx.sourceFile)?.kind === 'node'
                ) {
                    return null;
                }
                const nextResolving = new Set(resolving);
                nextResolving.add(key);
                return resolveExpandableExpression(
                    localDecl.initializer,
                    ctx,
                    callSiteRange,
                    nextResolving,
                    allowSingleStep,
                );
            }
            return null;
        }
        const binding = ctx.metadata.imports.get(expr.text);
        if (binding && !binding.isNamespace && ctx.session.depth < MAX_RESOLVE_DEPTH) {
            const importPath = resolveRelativeImportPath(ctx.filePath, binding.specifier);
            const targetCtx = importPath ? getOrLoadFileContext(importPath, ctx.session) : null;
            if (targetCtx) {
                const resolved = resolveExportTarget(targetCtx, binding.importedName, ctx.session);
                if (resolved) {
                    ctx.session.depth += 1;
                    try {
                        return resolveExportedTargetToSubflow(
                            resolved.ctx,
                            resolved.target,
                            callSiteRange,
                            ctx,
                            new Set(),
                        );
                    } finally {
                        ctx.session.depth -= 1;
                    }
                }
            }
        }
        return allowSingleStep ? resolveExpressionToSingleStep(expr, ctx) : null;
    }

    if (ts.isPropertyAccessExpression(expr)) {
        const base = unwrapTransparent(expr.expression);
        if (ts.isIdentifier(base)) {
            const binding = ctx.metadata.imports.get(base.text);
            if (binding?.isNamespace && ctx.session.depth < MAX_RESOLVE_DEPTH) {
                const importPath = resolveRelativeImportPath(ctx.filePath, binding.specifier);
                const targetCtx = importPath ? getOrLoadFileContext(importPath, ctx.session) : null;
                if (targetCtx) {
                    const resolved = resolveExportTarget(targetCtx, expr.name.text, ctx.session);
                    if (resolved) {
                        ctx.session.depth += 1;
                        try {
                            return resolveExportedTargetToSubflow(
                                resolved.ctx,
                                resolved.target,
                                callSiteRange,
                                ctx,
                                new Set(),
                            );
                        } finally {
                            ctx.session.depth -= 1;
                        }
                    }
                }
            }
        }
        return null;
    }

    if (ts.isCallExpression(expr)) {
        const rootFlow = findRootFlowCall(expr, ctx.sourceFile);
        if (rootFlow) {
            const doc = parseWorkflowChain(expr, rootFlow, ctx);
            return doc ? { nodes: doc.nodes, edges: doc.edges, unresolved: doc.unresolved } : null;
        }

        // Unwrap chained flow configuration or composition calls onto a resolved base flow.
        if (ts.isPropertyAccessExpression(expr.expression)) {
            const methodChain: MethodCall[] = [];
            let receiver: ts.Expression = expr;
            while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
                const methodName = receiver.expression.name.text;
                if (!FLOW_CHAIN_METHODS.has(methodName) && !FLOW_CONFIG_METHODS.has(methodName)) {
                    break;
                }
                methodChain.unshift({
                    methodName,
                    args: Array.from(receiver.arguments),
                    callExpr: receiver,
                });
                receiver = receiver.expression.expression;
            }
            if (methodChain.length > 0 && receiver !== expr) {
                const baseSubflow = resolveExpandableExpression(
                    receiver,
                    ctx,
                    callSiteRange,
                    resolving,
                    allowSingleStep,
                );
                if (baseSubflow) {
                    const hasWorkflowChain = methodChain.some(m => FLOW_CHAIN_METHODS.has(m.methodName));
                    if (!hasWorkflowChain) return baseSubflow;
                    const doc = buildWorkflowDocument('subflow', [], methodChain, ctx, baseSubflow);
                    return { nodes: doc.nodes, edges: doc.edges, unresolved: doc.unresolved };
                }
            }
        }

        const callee = unwrapTransparent(expr.expression);
        const calleeKind = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee) &&
                ['Step', 'Func', 'Chain'].includes(callee.expression.getText(ctx.sourceFile))
              ? callee.name.text
              : '';
        if (['parallel', 'all', 'race', 'allSettled', 'branch', 'when', 'map'].includes(calleeKind)) {
            const doc = buildWorkflowDocument(calleeKind, [expr], [], ctx);
            return { nodes: doc.nodes, edges: doc.edges, unresolved: doc.unresolved };
        }

        // Resolve call to a local or imported factory function.
        if (ts.isIdentifier(callee)) {
            const localDecl = findLexicalDeclaration(callee.text, expr, ctx.metadata.declarations);
            if (localDecl) {
                const fn = resolveFunctionLikeFromDecl(localDecl);
                if (fn) {
                    return resolveFunctionCallToSubflow(fn, ctx, callSiteRange, ctx);
                }
            }
            const binding = ctx.metadata.imports.get(callee.text);
            if (binding && !binding.isNamespace && ctx.session.depth < MAX_RESOLVE_DEPTH) {
                const importPath = resolveRelativeImportPath(ctx.filePath, binding.specifier);
                const targetCtx = importPath ? getOrLoadFileContext(importPath, ctx.session) : null;
                if (targetCtx) {
                    const resolved = resolveExportTarget(targetCtx, binding.importedName, ctx.session);
                    if (resolved) {
                        const fn =
                            resolved.target.kind === 'declaration'
                                ? resolveFunctionLikeFromDecl(resolved.target.node)
                                : resolved.target.kind === 'expression'
                                  ? resolveFunctionLikeFromDecl(resolved.target.expr)
                                  : null;
                        if (fn) {
                            return resolveFunctionCallToSubflow(fn, resolved.ctx, callSiteRange, ctx);
                        }
                    }
                }
            }
        } else if (ts.isPropertyAccessExpression(callee)) {
            const obj = unwrapTransparent(callee.expression);
            if (ts.isIdentifier(obj)) {
                const binding = ctx.metadata.imports.get(obj.text);
                if (binding?.isNamespace && ctx.session.depth < MAX_RESOLVE_DEPTH) {
                    const importPath = resolveRelativeImportPath(ctx.filePath, binding.specifier);
                    const targetCtx = importPath ? getOrLoadFileContext(importPath, ctx.session) : null;
                    if (targetCtx) {
                        const resolved = resolveExportTarget(targetCtx, callee.name.text, ctx.session);
                        if (resolved) {
                            const fn =
                                resolved.target.kind === 'declaration'
                                    ? resolveFunctionLikeFromDecl(resolved.target.node)
                                    : resolved.target.kind === 'expression'
                                      ? resolveFunctionLikeFromDecl(resolved.target.expr)
                                      : null;
                            if (fn) {
                                return resolveFunctionCallToSubflow(fn, resolved.ctx, callSiteRange, ctx);
                            }
                        }
                    }
                }
            }
        }
    }

    return allowSingleStep ? resolveExpressionToSingleStep(expr, ctx) : null;
}

export function runDiagnostics(
    nodes: GraphNode[],
    edges: GraphEdge[],
    workflowName?: string,
    properties?: Record<string, string>,
): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    // Helper to identify synthetic combinator hubs
    function isSyntheticNode(node: GraphNode): boolean {
        return (
            node.name.endsWith(' fork') ||
            node.name.endsWith(' join') ||
            node.name === 'inline action' ||
            node.id.includes('_fork_') ||
            node.id.includes('_join_') ||
            ['parallel', 'all', 'race', 'allSettled', 'branch', 'when', 'map'].includes(node.name)
        );
    }

    // 1. Detect duplicate step IDs
    const userNodes = nodes.filter(n => !isSyntheticNode(n));
    const nameToNodes = new Map<string, GraphNode[]>();
    for (const node of userNodes) {
        if (!nameToNodes.has(node.name)) nameToNodes.set(node.name, []);
        nameToNodes.get(node.name)!.push(node);
    }
    for (const [name, matchedNodes] of nameToNodes.entries()) {
        if (matchedNodes.length > 1) {
            for (const node of matchedNodes) {
                diagnostics.push({
                    code: 'SIGLO_DUPLICATE_STEP_ID',
                    message: `Duplicate step ID detected: "${name}"`,
                    severity: 'error',
                    range: node.location,
                });
            }
        }
    }

    // 2. Detect cycles in graph edges
    const adj = new Map<string, string[]>();
    for (const edge of edges) {
        if (!adj.has(edge.from)) adj.set(edge.from, []);
        adj.get(edge.from)!.push(edge.to);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();
    const cycleNodes = new Set<string>();

    function dfs(nodeId: string) {
        visited.add(nodeId);
        recStack.add(nodeId);

        const neighbors = adj.get(nodeId) || [];
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                dfs(neighbor);
            } else if (recStack.has(neighbor)) {
                cycleNodes.add(neighbor);
                cycleNodes.add(nodeId);
            }
        }
        recStack.delete(nodeId);
    }

    for (const node of nodes) {
        if (!visited.has(node.id)) {
            dfs(node.id);
        }
    }

    if (cycleNodes.size > 0) {
        for (const node of nodes) {
            if (cycleNodes.has(node.id)) {
                diagnostics.push({
                    code: 'SIGLO_STATIC_CYCLE',
                    message: `Cyclic workflow dependency detected involving step "${node.name}"`,
                    severity: 'warning',
                    range: node.location,
                });
            }
        }
    }

    // 3. Detect side-effect steps lacking compensation in sagas
    const hasAnyCompensationEdge = edges.some(e => e.type === 'compensation');
    const isSaga = hasAnyCompensationEdge || properties?.isSaga === 'true' || properties?.saga === 'true';
    if (isSaga) {
        for (const node of nodes) {
            const isSideEffect =
                node.stepKind === 'http' ||
                node.stepKind === 'crypto' ||
                (node.stepKind === 'notification' && node.properties?.autoCompensate !== 'true');
            if (isSideEffect && !node.executionConfig?.hasCompensation) {
                const hasOutCompensation = edges.some(e => e.from === node.id && e.type === 'compensation');
                if (!hasOutCompensation) {
                    diagnostics.push({
                        code: 'SIGLO_MISSING_COMPENSATION',
                        message: `Saga step "${node.name}" performs side effects without a registered compensation step`,
                        severity: 'warning',
                        range: node.location,
                        fixAvailable: true,
                    });
                }
            }
        }
    }

    // 4. Detect unhandled error branches in durable workflows
    const durableNodes = nodes.filter(
        n =>
            n.name.startsWith('wait:') ||
            n.name.startsWith('waitForEvent:') ||
            n.properties?.operation === 'wait' ||
            n.properties?.operation === 'waitForEvent' ||
            n.properties?.operation === 'Step.wait' ||
            n.properties?.operation === 'Step.waitForEvent' ||
            n.properties?.operation?.toLowerCase().includes('wait'),
    );
    const isDurableWorkflow = durableNodes.length > 0 || properties?.durable === 'true';
    if (isDurableWorkflow) {
        // Check for branch forks lacking a default or fallback route
        const branchForks = nodes.filter(
            n => n.name === 'branch fork' || n.properties?.operation === 'branch',
        );
        for (const fork of branchForks) {
            const outEdges = edges.filter(e => e.from === fork.id);
            const hasDefault = outEdges.some(
                e => e.label === 'default' || e.label?.includes('default') || e.type === 'fallback',
            );
            if (!hasDefault) {
                diagnostics.push({
                    code: 'SIGLO_UNHANDLED_ERROR_BRANCH',
                    message: `Durable workflow branch "${fork.name}" has unhandled error/default branch`,
                    severity: 'warning',
                    range: fork.location,
                });
            }
        }

        // Check for when forks lacking an else / fallback route
        const whenForks = nodes.filter(
            n => n.name === 'when fork' || n.properties?.operation === 'when',
        );
        for (const fork of whenForks) {
            const outEdges = edges.filter(e => e.from === fork.id);
            const hasElse = outEdges.some(
                e => e.label === 'else' || e.label?.includes('else') || e.type === 'fallback',
            );
            if (!hasElse) {
                diagnostics.push({
                    code: 'SIGLO_UNHANDLED_ERROR_BRANCH',
                    message: `Durable workflow conditional "${fork.name}" has unhandled alternate/error branch`,
                    severity: 'warning',
                    range: fork.location,
                });
            }
        }
    }

    return diagnostics;
}

function applyFlowProperty(
    properties: Record<string, string>,
    method: string,
    args: ts.Expression[],
    sourceFile: ts.SourceFile,
) {
    const arg = args[0];
    if (!arg && method !== 'networkPolicy') return;
    const value = arg
        ? ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)
            ? arg.text
            : arg.getText(sourceFile)
        : 'undefined';
    if (method === 'timeout') properties.timeoutMs = value;
    else if (method === 'version') properties.workflowVersion = value;
    else if (method === 'monitor') properties.monitor = value;
    else if (method === 'durable') properties.durable = 'true';
    else if (method === 'saga') properties.isSaga = 'true';
    else if (method === 'networkPolicy') {
        for (const key of Object.keys(properties)) if (key.startsWith('network.')) delete properties[key];
        const defaults = {
            'network.enabled': 'true',
            'network.defaultPolicy': 'deny',
            'network.allowedHosts': 'No hosts configured',
            'network.allowLocalhost': 'false',
        };
        if (!arg || (ts.isIdentifier(arg) && arg.text === 'undefined')) Object.assign(properties, defaults);
        else if (ts.isObjectLiteralExpression(arg)) {
            if (!arg.properties.some(prop => ts.isSpreadAssignment(prop))) Object.assign(properties, defaults);
            for (const prop of arg.properties) {
                if (ts.isSpreadAssignment(prop)) properties['network.source'] = value;
                if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
                    const key = prop.name.getText(sourceFile).replace(/['"]/g, '');
                    if (
                        ['enabled', 'defaultPolicy', 'allowedHosts', 'allowLocalhost', 'allowUnixSockets'].includes(key)
                    ) {
                        const expression = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
                        properties[`network.${key}`] = ts.isArrayLiteralExpression(expression)
                            ? expression.elements
                                  .map(e => (ts.isStringLiteral(e) ? e.text : e.getText(sourceFile)))
                                  .join('\n') || 'No entries'
                            : ts.isStringLiteral(expression)
                              ? expression.text
                              : expression.getText(sourceFile);
                    }
                }
            }
        } else properties['network.source'] = value;
    }
}
