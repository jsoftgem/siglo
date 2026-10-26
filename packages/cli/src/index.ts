import * as fs from 'fs';
import * as path from 'path';
import {
    Flow,
    toGraph,
    inspectGraph,
    validateGraph,
    GraphValidationResult,
    GraphInspectionResult
} from 'fluid-func';

export interface WorkflowVisualizationResult {
    mermaid: string;
    text: string;
    nodeCount: number;
    hasCycles: boolean;
}

export interface ReplayFixture {
    name?: string;
    version?: string;
    initialParam: Record<string, any>;
    expectedOutputs?: Record<string, any>;
    checkpoints?: any[];
}

export interface ReplayResult {
    success: boolean;
    durationMs: number;
    finalContext: Record<string, any>;
    diff?: Record<string, { expected: any; actual: any }>;
}

/**
 * Renders a GraphInspectionResult as a Mermaid flowchart diagram.
 */
export function toMermaid(inspection: GraphInspectionResult): string {
    const lines = ['flowchart TD'];
    for (const node of inspection.nodes) {
        lines.push(`    ${node.id}["${node.name} (${node.type})"]`);
    }
    for (const edge of inspection.edges) {
        if (edge.label) {
            lines.push(`    ${edge.from} -->|${edge.label}| ${edge.to}`);
        } else {
            lines.push(`    ${edge.from} --> ${edge.to}`);
        }
    }
    return lines.join('\n');
}

/**
 * Renders a GraphInspectionResult as an indented ASCII text tree diagram.
 */
export function toTextGraph(inspection: GraphInspectionResult): string {
    const lines = [`Workflow Graph (total nodes: ${inspection.totalNodes}, edges: ${inspection.edges.length}):`];
    for (let i = 0; i < inspection.nodes.length; i++) {
        const node = inspection.nodes[i];
        const isLast = i === inspection.nodes.length - 1;
        const prefix = isLast ? '└── ' : '├── ';
        lines.push(`${prefix}[${node.type}] ${node.name} (${node.id})`);
    }
    return lines.join('\n');
}

/**
 * Visualizes a fluid-func workflow graph as Mermaid and text flowchart representations.
 */
export function visualizeWorkflow(workflow: Flow): WorkflowVisualizationResult {
    const graph = toGraph(workflow);
    const inspection = inspectGraph(workflow);
    const validation = validateGraph(graph);

    return {
        mermaid: toMermaid(inspection),
        text: toTextGraph(inspection),
        nodeCount: inspection.totalNodes,
        hasCycles: !validation.valid,
    };
}

/**
 * Statically validates a workflow graph definition.
 */
export function validateWorkflow(workflow: Flow): GraphValidationResult {
    const graph = toGraph(workflow);
    return validateGraph(graph);
}

/**
 * Returns a diagnostic inspection report for a workflow with optional field redaction.
 */
export function inspectWorkflow(
    workflow: Flow,
    options: { redact?: string[] } = {}
): GraphInspectionResult & { redactedFields?: string[] } {
    const inspection = inspectGraph(workflow);
    const redactedFields = options.redact || [];

    if (redactedFields.length > 0) {
        const sanitizedNodes = inspection.nodes.map(n => {
            if (redactedFields.includes(n.name)) {
                return { ...n, name: '[REDACTED]' };
            }
            return n;
        });
        return {
            ...inspection,
            nodes: sanitizedNodes,
            redactedFields,
        };
    }

    return inspection;
}

/**
 * Replays a workflow execution against a recorded test fixture.
 */
export async function replayFixture(
    workflow: Flow,
    fixture: ReplayFixture | string
): Promise<ReplayResult> {
    const parsedFixture: ReplayFixture = typeof fixture === 'string'
        ? JSON.parse(fs.readFileSync(fixture, 'utf-8'))
        : fixture;

    const startTime = Date.now();
    const result = await workflow.run(parsedFixture.initialParam, { pojo: true });
    const durationMs = Date.now() - startTime;

    let success = true;
    const diff: Record<string, { expected: any; actual: any }> = {};

    if (parsedFixture.expectedOutputs) {
        for (const [key, expectedVal] of Object.entries(parsedFixture.expectedOutputs)) {
            const actualVal = (result as any)[key];
            if (JSON.stringify(actualVal) !== JSON.stringify(expectedVal)) {
                success = false;
                diff[key] = { expected: expectedVal, actual: actualVal };
            }
        }
    }

    return {
        success,
        durationMs,
        finalContext: result,
        diff: Object.keys(diff).length > 0 ? diff : undefined,
    };
}

/**
 * Inspects a serialized checkpoint with optional field redaction.
 */
export function inspectCheckpoint(
    checkpoint: any | string,
    options: { redact?: string[] } = {}
): Record<string, any> {
    const parsed: any = typeof checkpoint === 'string'
        ? JSON.parse(checkpoint)
        : checkpoint;

    const redactKeys = options.redact || [];
    const contexts = { ...(parsed.contexts || {}) };

    if (redactKeys.length > 0) {
        for (const stepId of Object.keys(contexts)) {
            const stepCtx = { ...contexts[stepId] };
            for (const key of Object.keys(stepCtx)) {
                if (redactKeys.includes(key)) {
                    stepCtx[key] = '[REDACTED]';
                }
            }
            contexts[stepId] = stepCtx;
        }
    }

    return {
        stackId: parsed.stackId,
        namespace: parsed.namespace,
        type: parsed.type,
        stepCount: parsed.chains?.length || 0,
        chains: parsed.chains,
        contexts,
    };
}

/**
 * Scaffolds a new starter fluid-func project directory.
 */
export function initProject(targetDir: string = process.cwd()): { filesCreated: string[] } {
    const srcDir = path.join(targetDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const packageJsonPath = path.join(targetDir, 'package.json');
    const workflowPath = path.join(srcDir, 'workflow.ts');
    const testPath = path.join(srcDir, 'workflow.test.ts');

    const filesCreated: string[] = [];

    if (!fs.existsSync(packageJsonPath)) {
        const pkg = {
            name: 'my-fluid-workflow',
            version: '1.0.0',
            description: 'Starter project built with fluid-func workflow runtime',
            scripts: {
                test: 'tsx --test src/**/*.test.ts',
                start: 'tsx src/workflow.ts',
            },
            dependencies: {
                'fluid-func': '^2.0.0',
            },
            devDependencies: {
                tsx: '^4.0.0',
                typescript: '~5.7.0',
            },
        };
        fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
        filesCreated.push(packageJsonPath);
    }

    if (!fs.existsSync(workflowPath)) {
        const code = `import { Step, flow } from 'fluid-func';

export interface OrderInput {
    orderId: string;
    amount: number;
}

export function createOrderWorkflow() {
    const validateOrder = Step.create('validateOrder', async ({ orderId, amount }: any) => {
        if (!orderId) throw new Error('Missing orderId');
        return { validated: true, orderId, amount };
    }).modern();

    const processPayment = Step.create('processPayment', async ({ amount }: any) => {
        return { paymentStatus: 'CHARGED', amountCharged: amount };
    }).modern();

    return flow(validateOrder, processPayment);
}
`;
        fs.writeFileSync(workflowPath, code);
        filesCreated.push(workflowPath);
    }

    if (!fs.existsSync(testPath)) {
        const testCode = `import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderWorkflow } from './workflow';

test('Order workflow executes successfully', async () => {
    const workflow = createOrderWorkflow();
    const result = await workflow.run({ orderId: 'ORD-1', amount: 100 });
    assert.equal(result.validated(), true);
    assert.equal(result.paymentStatus(), 'CHARGED');
});
`;
        fs.writeFileSync(testPath, testCode);
        filesCreated.push(testPath);
    }

    return { filesCreated };
}
