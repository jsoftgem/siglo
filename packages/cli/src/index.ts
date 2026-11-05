import { GenerateStepOptions, validateStepOptions, ecosystemTemplate } from './step-templates';
export type { GenerateStepOptions } from './step-templates';
import * as fs from 'fs';
import * as path from 'path';
import {
    Flow,
    toGraph,
    inspectGraph,
    validateGraph,
    GraphValidationResult,
    GraphInspectionResult,
    parseDuration,
    reconcileAbandonedStacks
} from '@siglo/core';

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
 * Visualizes a siglo workflow graph as Mermaid and text flowchart representations.
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
        const sanitizedNodes = inspection.nodes.map((n: any) => {
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
 * Scaffolds a new starter siglo project directory.
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
            name: 'my-siglo-workflow',
            version: '1.0.0',
            description: 'Starter project built with siglo workflow runtime',
            scripts: {
                test: 'tsx --test src/**/*.test.ts',
                start: 'tsx src/workflow.ts',
            },
            dependencies: {
                '@siglo/core': '^1.0.0',
            },
            devDependencies: {
                '@siglo/testing': '^1.0.0',
                '@types/node': '^22.0.0',
                chai: '^5.0.0',
                tsx: '^4.0.0',
                typescript: '~5.7.0',
            },
        };
        fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
        filesCreated.push(packageJsonPath);
    }

    if (!fs.existsSync(workflowPath)) {
        const code = `import { Step, flow } from '@siglo/core';\n\nexport interface OrderInput {\n    orderId: string;\n    amount: number;\n}\n\nexport function createOrderWorkflow() {\n    const validateOrder = Step.create('validateOrder', async ({ orderId, amount }: any) => {\n        if (!orderId) throw new Error('Missing orderId');\n        return { validated: true, orderId, amount };\n    });\n\n    const processPayment = Step.create('processPayment', async ({ amount }: any) => {\n        return { paymentStatus: 'CHARGED', amountCharged: amount };\n    });\n\n    return flow(validateOrder, processPayment);\n}\n`;
        fs.writeFileSync(workflowPath, code);
        filesCreated.push(workflowPath);
    }

    if (!fs.existsSync(testPath)) {
        const testCode = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createOrderWorkflow } from './workflow';\n\ntest('Order workflow executes successfully', async () => {\n    const workflow = createOrderWorkflow();\n    const result = await workflow.run({ orderId: 'ORD-1', amount: 100 });\n    assert.equal(result.validated, true);\n    assert.equal(result.paymentStatus, 'CHARGED');\n});\n`;
        fs.writeFileSync(testPath, testCode);
        filesCreated.push(testPath);
    }

    return { filesCreated };
}

/**
 * Scaffolds a new typed workflow file and test.
 */
export function generateWorkflow(name: string, targetDir: string = process.cwd()): { filePath: string; testPath: string } {
    const srcDir = path.join(targetDir, "src", "workflows");
    fs.mkdirSync(srcDir, { recursive: true });

    const kebabName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const pascalName = kebabName.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
    const camelName = pascalName.charAt(0).toLowerCase() + pascalName.slice(1);

    const filePath = path.join(srcDir, `${kebabName}.workflow.ts`);
    const testPath = path.join(srcDir, `${kebabName}.workflow.test.ts`);

    const workflowContent = `import { Step, flow } from '@siglo/core';\n\nexport interface ${pascalName}Input {\n    id: string;\n}\n\nexport interface ${pascalName}Output {\n    id: string;\n    status: string;\n}\n\nexport const step1 = Step.create("validate", async (param: ${pascalName}Input) => {\n    if (!param.id) throw new Error("Missing required field: id");\n    return { validated: true };\n});\n\nexport const step2 = Step.create("process", async (param: ${pascalName}Input & { validated: boolean }) => {\n    return { status: "COMPLETED" };\n});\n\nexport const ${camelName}Workflow = flow(step1, step2);\nexport default ${camelName}Workflow;\n`;

    const testContent = `import { expect } from "chai";\nimport { createWorkflowHarness } from "@siglo/testing";\nimport { ${camelName}Workflow } from "./${kebabName}.workflow";\n\ndescribe("${pascalName}Workflow", () => {\n    it("executes successfully", async () => {\n        const harness = createWorkflowHarness(${camelName}Workflow);\n        const result = await harness.run({ id: "test-123" });\n        expect(result.status).to.equal("COMPLETED");\n        harness.assertStepExecuted("validate");\n        harness.assertStepExecuted("process");\n    });\n});\n`;

    fs.writeFileSync(filePath, workflowContent, "utf-8");
    fs.writeFileSync(testPath, testContent, "utf-8");

    return { filePath, testPath };
}

/**
 * Scaffolds a new typed step file and test.
 */
export function generateStep(name: string, targetDir: string = process.cwd(), options: GenerateStepOptions = {}): { filePath: string; testPath: string } {
    validateStepOptions(name, options);
    const srcDir = path.join(targetDir, "src", "steps");


    const kebabName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const pascalName = kebabName.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
    const camelName = pascalName.charAt(0).toLowerCase() + pascalName.slice(1);

    const filePath = path.join(srcDir, `${kebabName}.step.ts`);
    const testPath = path.join(srcDir, `${kebabName}.step.test.ts`);

    const stepContent = `import { Step } from '@siglo/core';\n\nexport interface ${pascalName}Input {\n    [key: string]: any;\n}\n\nexport interface ${pascalName}Output {\n    success: boolean;\n}\n\nexport const ${camelName}Step = Step.create("${kebabName}", async (param: ${pascalName}Input): Promise<${pascalName}Output> => {\n    return { success: true };\n});\n\nexport default ${camelName}Step;\n`;

    const testContent = `import { expect } from "chai";\nimport { ${camelName}Step } from "./${kebabName}.step";\n\ndescribe("${pascalName}Step", () => {\n    it("executes successfully", async () => {\n        const result = await ${camelName}Step.execute({});\n        expect(result.success).to.be.true;\n    });\n});\n`;

    const template = ecosystemTemplate(pascalName, kebabName, options);
    if (fs.existsSync(filePath) || fs.existsSync(testPath)) throw new Error('Step destination already exists');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(filePath, template?.source ?? stepContent, { encoding: 'utf-8', flag: 'wx' });
    try {
        fs.writeFileSync(testPath, template?.test ?? testContent, { encoding: 'utf-8', flag: 'wx' });
    } catch (error) {
        fs.unlinkSync(filePath);
        throw error;
    }

    return { filePath, testPath };
}

export interface ExportWorkflowOptions {
    format?: "mermaid" | "dot" | "json";
    direction?: "TD" | "LR" | "TB";
    includeBadges?: boolean;
}

/**
 * Exports a workflow graph to Mermaid, Graphviz DOT, or JSON format.
 */
export function exportWorkflow(
    workflow: any,
    options: ExportWorkflowOptions = {}
): string {
    const format = options.format || "mermaid";
    if (format === "json") {
        return typeof workflow.toJSON === "function"
            ? workflow.toJSON()
            : JSON.stringify(workflow, null, 2);
    }
    if (format === "dot") {
        return typeof workflow.toDot === "function"
            ? workflow.toDot({ direction: options.direction as any })
            : "";
    }
    // Default: mermaid
    return typeof workflow.toMermaid === "function"
        ? workflow.toMermaid({ direction: options.direction, includeBadges: options.includeBadges })
        : toMermaid(inspectGraph(workflow));
}

export interface MonitorOptions {
    port?: number;
    host?: string;
    open?: boolean;
    namespace?: string;
    flow?: any;
}

/**
 * Starts the live workflow monitoring dev server and web dashboard.
 */
export async function startMonitor(options: MonitorOptions = {}): Promise<any> {
    const { createMonitorServer } = await import("@siglo/monitor");
    return createMonitorServer({
        port: options.port,
        host: options.host,
        namespaceFilter: options.namespace,
        flow: options.flow,
        open: options.open
    });
}

export interface ReconcileCommandOptions {
    staleThreshold?: string;
    action?: "compensate" | "fail" | "inspect";
    mode?: "strict" | "best-effort";
    namespace?: string;
    flow?: any;
    stacks?: any[];
}

/**
 * Reconciles abandoned workflow stacks stuck in RUNNING state past a stale threshold.
 */
export async function reconcileCommand(options: ReconcileCommandOptions = {}): Promise<any> {
    const staleMs = options.staleThreshold ? parseDuration(options.staleThreshold) : 10 * 60 * 1000;
    return reconcileAbandonedStacks({
        staleThresholdMs: staleMs,
        action: options.action,
        mode: options.mode,
        namespace: options.namespace,
        flowLookup: () => options.flow,
        stacks: options.stacks
    });
}
