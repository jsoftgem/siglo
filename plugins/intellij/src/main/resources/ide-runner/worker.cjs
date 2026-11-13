// Application code runs only in this disposable child, never in the analyzer or IDE host.
const { createRequire } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { resolve } = require('node:path');
const controller = new AbortController();
let request;
const send = event =>
    new Promise(resolve => process.send?.({ type: 'runEvent', runId: request.runId, ...event }, () => resolve()));
function jsonValue(value) {
    const text = JSON.stringify(value, (_key, item) => {
        if (
            ['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) ||
            (typeof item === 'number' && !Number.isFinite(item))
        )
            throw new Error('Output is not JSON-compatible.');
        if (item && typeof item === 'object') {
            // JSON.stringify detects cycles; shared noncyclic references are valid.
            if (item instanceof Map || item instanceof Set)
                throw new Error('Output contains a Map or Set; return JSON-compatible data.');
        }
        return item;
    });
    if (text === undefined) throw new Error('Output is not JSON-compatible.');
    return JSON.parse(text);
}
process.on('message', async message => {
    if (message.type === 'cancel') {
        controller.abort();
        return;
    }
    if (request) return;
    request = message;
    const start = Date.now();
    try {
        const projectRequire = createRequire(request.file);
        let load = url => import(url);
        if (/\.[cm]?tsx?$/.test(request.file) || request.setupModule) {
            let esmApi;
            let cjsApi;
            try {
                cjsApi = projectRequire('tsx/cjs/api');
            } catch {}
            try {
                esmApi = projectRequire('tsx/esm/api');
            } catch {}
            if (!cjsApi && !esmApi) {
                throw new Error('Install tsx in this project to execute TypeScript or setup modules.');
            }
            if (cjsApi) {
                cjsApi.register();
                load = async url => {
                    const filePath = typeof url === 'string' && url.startsWith('file:') ? fileURLToPath(url) : url;
                    return projectRequire(filePath);
                };
            } else {
                load = url => esmApi.tsImport(url, { parentURL: pathToFileURL(request.file).href });
            }
        }
        if (controller.signal.aborted) throw new Error('Cancelled.');
        if (request.setupModule) await load(pathToFileURL(resolve(request.cwd, request.setupModule)).href);
        const module = await load(pathToFileURL(request.file).href);
        const workflow = module[request.exportName] ?? module.default?.[request.exportName];
        if (!workflow?.steps || !workflow.toGraph)
            throw new Error(`Export ${request.exportName} is not a runnable Siglo workflow.`);
        const core = projectRequire('@siglo/core');
        const leaves = [];
        function visit(node, group) {
            if (node.type === 'step' || node.type === 'wait') {
                leaves.push({ node, group });
                return;
            }
            if (node.type === 'sequence') {
                for (const child of node.children) visit(child, node);
                return;
            }
            if (node.branches) for (const branch of Object.values(node.branches)) visit(branch, branch);
            if (node.itemNode) visit(node.itemNode, node.itemNode);
        }
        const graph = workflow.toGraph();
        visit(graph, graph);
        const matchName = (a, b) => {
            if (a === b) return true;
            const norm = s => (s || '').replace(/['"`\s]+/g, '').toLowerCase();
            return norm(a) === norm(b);
        };
        if (
            leaves.length !== request.signature.length ||
            leaves.some((leaf, i) => !matchName(leaf.node.name, request.signature[i]))
        )
            throw new Error(
                'Runtime workflow differs from the displayed graph. Reload or use a statically resolvable workflow.',
            );
        const selected = request.targets.map(target => ({
            ...leaves[target.index],
            target,
        }));
        if (selected.some(item => !item.node)) throw new Error('Stale step positions. Reload the graph.');
        if (selected.length > 1 && selected.some(item => item.group !== selected[0].group))
            throw new Error('Selection crosses a composite boundary.');
        // Require graph references before executing to avoid silently losing result observation on old runtimes.
        const steps = selected.map(item => item.node.step);
        if (steps.some(step => !step))
            throw new Error(
                'Update @siglo/core to the runtime supporting graph step references and onStepResult before running steps.',
            );
        if (new Set(steps.map(step => step.name)).size !== steps.length)
            throw new Error('Selected steps must have unique names.');
        const subset = core.flow(...steps);
        if (workflow.timeoutMs !== undefined) subset.timeout(workflow.timeoutMs);
        if (workflow.workflowVersion !== undefined) subset.version(workflow.workflowVersion);
        if (workflow.networkPolicyConfig) subset.networkPolicy(workflow.networkPolicyConfig);
        if (workflow.stepExecutionHook) subset.hook(workflow.stepExecutionHook);
        let serializationError;
        const captured = new Map();
        const cleanOutput = value => {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
            return Object.fromEntries(Object.entries(value).filter(([key]) => !core.isReservedKey(key)));
        };
        subset.monitor(event => {
            const index = steps.findIndex(step => step.$stepId === event.stepId);
            if (index >= 0 && event.type === 'step:start') send({ status: 'step', nodeId: selected[index].target.id });
            const monitor = workflow.monitorEmitter;
            if (typeof monitor === 'function') monitor(event);
            else if (monitor?.emit) monitor.emit(event);
        });
        send({ status: 'started' });
        await subset.run(request.input, {
            pojo: true,
            signal: controller.signal,
            onStepResult: (name, value) => {
                const index = steps.findIndex(step => step.name === name);
                if (index < 0) return;
                try {
                    const output = jsonValue(cleanOutput(value));
                    captured.set(index, output);
                    send({
                        status: 'step',
                        nodeId: selected[index].target.id,
                        output,
                    });
                } catch (error) {
                    serializationError = error;
                }
            },
        });
        if (serializationError) throw serializationError;
        if (captured.size !== steps.length && !controller.signal.aborted)
            throw new Error(
                'Update @siglo/core to a version supporting onStepResult to inspect resolved step outputs.',
            );
        await send({
            status: controller.signal.aborted ? 'cancelled' : 'completed',
            output: captured.get(steps.length - 1),
            elapsedMs: Date.now() - start,
        });
    } catch (error) {
        await send({
            status: controller.signal.aborted ? 'cancelled' : 'failed',
            error: error.message || String(error),
            elapsedMs: Date.now() - start,
        });
    } finally {
        process.disconnect?.();
        process.exit(0);
    }
});
