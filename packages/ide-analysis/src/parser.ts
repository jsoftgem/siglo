import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type {
    GraphDocument,
    WorkflowGraph,
    SourcePosition,
    ResolveLocationResult,
    DiscoveredWorkflow,
} from '@siglo/ide-protocol';
import { normalizeUri, toFilePath, isPositionInRange } from './mapper';
import { analyzeWorkflowsInSourceFile } from './patterns/workflow-detector';

export interface ParseOptions {
    uri: string;
    documentVersion?: number;
    content?: string;
    workflowName?: string;
}

export function parseWorkflowFile(options: ParseOptions): GraphDocument {
    const uri = normalizeUri(options.uri);
    const filePath = toFilePath(options.uri);
    const documentVersion = options.documentVersion ?? 1;

    let sourceText = options.content;
    if (sourceText === undefined) {
        try {
            sourceText = fs.readFileSync(filePath, 'utf-8');
        } catch {
            sourceText = '';
        }
    }

    // Pure static syntax-only AST creation. Never executes any JavaScript.
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const workflows = analyzeWorkflowsInSourceFile(sourceFile, uri, documentVersion);
    if (workflows.length === 0) {
        return {
            uri,
            documentVersion,
            workflowName: path.basename(filePath, path.extname(filePath)) || 'workflow',
            nodes: [],
            edges: [],
            unresolved: [],
            diagnostics: [],
            workflows: [],
        };
    }

    // Static export and structural position metadata. Never imports application code.
    const exports = new Map<string, string>();
    for (const statement of sourceFile.statements) {
        if (
            ts.isVariableStatement(statement) &&
            statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) exports.set(declaration.name.text, declaration.name.text);
            }
        }
        if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression))
            exports.set(statement.expression.text, 'default');
        if (
            ts.isExportDeclaration(statement) &&
            !statement.moduleSpecifier &&
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause)
        ) {
            for (const item of statement.exportClause.elements)
                exports.set(item.propertyName?.text || item.name.text, item.name.text);
        }
    }
    for (const workflow of workflows) {
        workflow.nodes = workflow.nodes.map(node => ({ ...node, executionTarget: undefined }));
        const exportName = exports.get(workflow.workflowName);
        if (!exportName || workflow.unresolved.length) continue;
        const recovery = new Set(
            workflow.edges.filter(e => e.type === 'fallback' || e.type === 'compensation').map(e => e.to),
        );
        let stepIndex = 0;
        for (const node of workflow.nodes) {
            if (
                recovery.has(node.id) ||
                /_(fork|join)_/.test(node.id) ||
                / (fork|join)$/.test(node.name) ||
                ['parallel', 'all', 'race', 'allSettled', 'branch', 'when', 'map', 'inline action'].includes(node.name)
            )
                continue;
            node.executionTarget = { exportName, stepIndex: stepIndex++ };
        }
    }

    const workflowSummaries: WorkflowGraph[] = workflows.map(w => ({
        name: w.workflowName,
        uri: w.uri,
        ...(w.location ? { location: w.location } : {}),
        properties: w.properties,
        nodes: w.nodes,
        edges: w.edges,
        unresolved: w.unresolved,
        diagnostics: w.diagnostics,
    }));

    let activeFlow = workflows[workflows.length - 1];
    if (options.workflowName) {
        const found = workflows.find(w => w.workflowName === options.workflowName);
        if (found) {
            activeFlow = found;
        }
    }

    return {
        ...activeFlow,
        workflows: workflowSummaries,
    };
}

export function resolveLocationInDocument(doc: GraphDocument, pos: SourcePosition): ResolveLocationResult {
    // Check nodes first
    for (const node of doc.nodes) {
        if (isPositionInRange(pos, node.location) || isPositionInRange(pos, node.declarationRange)) {
            return {
                nodeId: node.id,
                range: node.location,
            };
        }
    }

    // Check unresolved nodes
    for (const un of doc.unresolved) {
        if (isPositionInRange(pos, un.location)) {
            return {
                nodeId: un.id,
                range: un.location,
            };
        }
    }

    return {};
}

export function discoverWorkflows(params: { documentUri?: string; workspaceUri?: string }): DiscoveredWorkflow[] {
    const results: DiscoveredWorkflow[] = [];

    if (params.documentUri) {
        const filePath = toFilePath(params.documentUri);
        let content: string | undefined;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            content = '';
        }
        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const workflows = analyzeWorkflowsInSourceFile(sourceFile, normalizeUri(params.documentUri), 1);
        for (const w of workflows) {
            if (w.nodes.length > 0) {
                results.push({
                    id: `${w.workflowName}_${path.basename(filePath)}`,
                    name: w.workflowName,
                    uri: w.uri,
                    range: w.nodes[0].location,
                });
            }
        }
        return results;
    }

    if (params.workspaceUri) {
        const rootDir = toFilePath(params.workspaceUri);
        if (!fs.existsSync(rootDir)) {
            return results;
        }

        const filesToScan: string[] = [];
        const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.idea', 'build']);

        function scanDir(dir: string, depth = 0) {
            if (depth > 8 || filesToScan.length >= 100) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        if (!IGNORED_DIRS.has(entry.name)) {
                            scanDir(path.join(dir, entry.name), depth + 1);
                        }
                    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.workflow.ts'))) {
                        filesToScan.push(path.join(dir, entry.name));
                        if (filesToScan.length >= 100) break;
                    }
                }
            } catch {
                // ignore permission or unreadable dirs
            }
        }

        scanDir(rootDir);

        for (const file of filesToScan) {
            try {
                const content = fs.readFileSync(file, 'utf-8');
                // Quick heuristic check before parsing AST
                if (content.includes('flow(') || content.includes('workflow(') || content.includes('Step.create(')) {
                    const sourceFile = ts.createSourceFile(
                        file,
                        content,
                        ts.ScriptTarget.Latest,
                        true,
                        ts.ScriptKind.TS,
                    );
                    const workflows = analyzeWorkflowsInSourceFile(sourceFile, normalizeUri(file), 1);
                    for (const w of workflows) {
                        if (w.nodes.length > 0) {
                            results.push({
                                id: `${w.workflowName}_${path.basename(file)}`,
                                name: w.workflowName,
                                uri: w.uri,
                                range: w.nodes[0]?.location || {
                                    start: { line: 0, character: 0 },
                                    end: { line: 0, character: 0 },
                                },
                            });
                        }
                    }
                }
            } catch {
                // ignore
            }
        }
    }

    return results;
}
