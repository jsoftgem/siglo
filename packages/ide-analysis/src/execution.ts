import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { executionRange, type GraphDocument, type RunRequest } from '@siglo/ide-protocol';
import { parseWorkflowFile } from './parser';

/** Re-analyze saved code and validate the host snapshot before importing any application module. */
export function prepareExecution(message: RunRequest & { document: GraphDocument; source: string; cwd?: string }) {
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
    try {
        settings = JSON.parse(readFileSync(resolve(cwd, '.siglo/run.json'), 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('Invalid .siglo/run.json configuration.');
    }
    if (settings.env && Object.values(settings.env).some(value => typeof value !== 'string'))
        throw new Error('Run environment values must be strings.');
    return {
        runId: message.runId,
        file,
        input: message.input,
        cwd: resolve(cwd, settings.cwd || '.'),
        setupModule: settings.setupModule,
        env: settings.env,
        exportName: selected[0].executionTarget!.exportName,
        signature: saved.nodes
            .filter(n => n.executionTarget)
            .sort((a, b) => a.executionTarget!.stepIndex - b.executionTarget!.stepIndex)
            .map(n => n.name),
        targets: selected.map(n => ({ id: n.id, index: n.executionTarget!.stepIndex })),
    };
}
