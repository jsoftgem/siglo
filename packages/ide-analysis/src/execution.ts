import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { executionRange, type GraphDocument, type RunRequest } from '@siglo/ide-protocol';
import { parseWorkflowFile } from './parser';

export interface PreparedExecution {
    runId: string;
    file: string;
    input: unknown;
    cwd: string;
    setupModule?: string;
    env?: Record<string, string>;
    exportName: string;
    signature: string[];
    targets: Array<{ id: string; index: number }>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrnoWithCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
    );
}

/** Re-analyze saved code and validate the host snapshot before importing any application module. */
export function prepareExecution(
    message: RunRequest & { document: GraphDocument; source: string; cwd?: string },
): PreparedExecution {
    const file = fileURLToPath(message.document.uri);
    if (message.uri !== message.document.uri || message.documentVersion !== message.document.documentVersion)
        throw new Error('Stale workflow selection. Reload the graph.');
    if (readFileSync(file, 'utf8') !== message.source)
        throw new Error('Save source changes and reload before running.');
    const saved = parseWorkflowFile({ uri: message.uri, workflowName: message.workflowName });
    const displayed =
        message.document.workflows?.find(w => w.name === message.workflowName) ??
        (message.document.workflowName === message.workflowName ? message.document : undefined);
    if (!displayed || saved.workflowName !== message.workflowName) throw new Error('Workflow is no longer available.');
    const signature = (nodes: typeof saved.nodes) =>
        nodes.filter(n => n.executionTarget).map(n => ({ id: n.id, name: n.name, target: n.executionTarget }));
    if (
        JSON.stringify(signature(saved.nodes)) !== JSON.stringify(signature(displayed.nodes)) ||
        JSON.stringify(saved.edges) !== JSON.stringify(displayed.edges)
    )
        throw new Error('Workflow changed. Reload before running.');
    const selected = executionRange(saved.nodes, saved.edges, message.nodeIds);
    const cwd = message.cwd || dirname(file);
    let settings: { cwd?: string; setupModule?: string; env?: Record<string, string> } = {};
    let parsedConfig: unknown;
    let hasConfig = false;
    try {
        parsedConfig = JSON.parse(readFileSync(resolve(cwd, '.siglo/run.json'), 'utf8'));
        hasConfig = true;
    } catch (error) {
        if (!isErrnoWithCode(error, 'ENOENT')) throw new Error('Invalid .siglo/run.json configuration.');
    }
    if (hasConfig) {
        if (!isPlainRecord(parsedConfig)) throw new Error('Invalid .siglo/run.json configuration.');
        if (parsedConfig.cwd !== undefined && typeof parsedConfig.cwd !== 'string')
            throw new Error('Invalid .siglo/run.json configuration.');
        if (parsedConfig.setupModule !== undefined && typeof parsedConfig.setupModule !== 'string')
            throw new Error('Invalid .siglo/run.json configuration.');
        let env: Record<string, string> | undefined;
        if (parsedConfig.env !== undefined) {
            if (!isPlainRecord(parsedConfig.env)) throw new Error('Invalid .siglo/run.json configuration.');
            if (Object.values(parsedConfig.env).some(value => typeof value !== 'string'))
                throw new Error('Run environment values must be strings.');
            env = parsedConfig.env as Record<string, string>;
        }
        settings = { cwd: parsedConfig.cwd, setupModule: parsedConfig.setupModule, env };
    }
    const entryTarget = selected[0]?.executionTarget;
    if (!entryTarget) throw new Error('Selection is not independently executable.');
    return {
        runId: message.runId,
        file,
        input: message.input,
        cwd: resolve(cwd, settings.cwd || '.'),
        setupModule: settings.setupModule,
        env: settings.env,
        exportName: entryTarget.exportName,
        signature: saved.nodes
            .flatMap(n => (n.executionTarget ? [{ name: n.name, stepIndex: n.executionTarget.stepIndex }] : []))
            .sort((a, b) => a.stepIndex - b.stepIndex)
            .map(n => n.name),
        targets: selected.map(n => ({ id: n.id, index: n.executionTarget?.stepIndex ?? entryTarget.stepIndex })),
    };
}
