import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Step, flow, parallel } from 'siglo';
import {
    visualizeWorkflow,
    validateWorkflow,
    inspectWorkflow,
    toTextGraph,
    initProject,
    replayFixture,
    inspectCheckpoint,
    generateWorkflow,
    generateStep,
    exportWorkflow,
    startMonitor,
    reconcileCommand
} from './index';

describe('@siglo/cli Developer Tools Suite', () => {
    it('visualizes workflow as Mermaid and text diagram', () => {
        const step1 = Step.create('validate', async () => ({ valid: true }));
        const step2 = Step.create('charge', async () => ({ charged: true }));
        const testFlow = flow(step1, parallel(step2));

        const result = visualizeWorkflow(testFlow);
        expect(result.mermaid).to.include('flowchart TD');
        expect(result.mermaid).to.include('validate');
        expect(result.mermaid).to.include('charge');
        expect(result.text).to.include('Workflow Graph');
        expect(result.nodeCount).to.be.greaterThan(1);
        expect(result.hasCycles).to.be.false;
    });

    it('renders text graph tree via toTextGraph', () => {
        const testFlow = flow(Step.create('step1', async () => ({})));
        const inspection = testFlow.inspect();
        const text = toTextGraph(inspection);
        expect(text).to.include('Workflow Graph');
        expect(text).to.include('step1');
    });

    it('validates healthy workflows', () => {
        const stepA = Step.create('stepA', async () => ({ a: 1 }));
        const testFlow = flow(stepA);

        const validation = validateWorkflow(testFlow);
        expect(validation.valid).to.be.true;
        expect(validation.errors).to.have.lengthOf(0);
    });

    it('inspects workflow and returns complexity summary with field redaction', () => {
        const stepA = Step.create('secretStep', async () => ({ a: 1 }));
        const stepB = Step.create('publicStep', async () => ({ b: 2 }));
        const testFlow = flow(stepA, stepB);

        const inspection = inspectWorkflow(testFlow, { redact: ['secretStep'] });
        expect(inspection.totalNodes).to.be.greaterThan(0);
        expect(inspection.nodes.some(n => n.name === '[REDACTED]')).to.be.true;
        expect(inspection.nodes.some(n => n.name === 'publicStep')).to.be.true;
    });

    it('replays a recorded test fixture against a workflow', async () => {
        const calculateFlow = flow(
            Step.create('calc', async ({ amount }: any) => ({
                doubled: amount * 2,
                status: 'OK'
            }))
        );

        const fixture = {
            initialParam: { amount: 25 },
            expectedOutputs: { doubled: 50, status: 'OK' }
        };

        const result = await replayFixture(calculateFlow, fixture);
        expect(result.success).to.be.true;
        expect(result.finalContext.doubled).to.equal(50);
        expect(result.diff).to.be.undefined;
    });

    it('detects output diff in replayFixture when expectations fail', async () => {
        const dummyFlow = flow(
            Step.create('dummy', async () => ({ value: 100 }))
        );

        const fixture = {
            initialParam: {},
            expectedOutputs: { value: 999 }
        };

        const result = await replayFixture(dummyFlow, fixture);
        expect(result.success).to.be.false;
        expect(result.diff).to.deep.equal({
            value: { expected: 999, actual: 100 }
        });
    });

    it('inspects and redacts sensitive checkpoint fields', () => {
        const checkpoint = {
            stackId: 'stack-123',
            namespace: 'tenant-acme',
            type: 'flow',
            chains: ['step-1'],
            contexts: {
                'step-1': {
                    secretKey: 'top-secret-token',
                    publicStatus: 'READY'
                }
            }
        };

        const inspected = inspectCheckpoint(checkpoint, { redact: ['secretKey'] });
        expect(inspected.stackId).to.equal('stack-123');
        expect(inspected.contexts['step-1'].secretKey).to.equal('[REDACTED]');
        expect(inspected.contexts['step-1'].publicStatus).to.equal('READY');
    });

    it('scaffolds starter project files via initProject', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siglo-cli-init-test-'));
        try {
            const res = initProject(tempDir);
            expect(res.filesCreated.length).to.equal(3);
            expect(fs.existsSync(path.join(tempDir, 'package.json'))).to.be.true;
            expect(fs.existsSync(path.join(tempDir, 'src/workflow.ts'))).to.be.true;
            expect(fs.existsSync(path.join(tempDir, 'src/workflow.test.ts'))).to.be.true;
            const testCode = fs.readFileSync(path.join(tempDir, 'src/workflow.test.ts'), 'utf-8');
            expect(testCode).to.include('result.validated, true');
            expect(testCode).to.not.include('result.validated()');
            const pkgJson = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf-8'));
            expect(pkgJson.devDependencies).to.have.property('@siglo/testing');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it("scaffolds typed workflow files via generateWorkflow", () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "siglo-cli-wf-test-"));
        try {
            const res = generateWorkflow("order-processing", tempDir);
            expect(fs.existsSync(res.filePath)).to.be.true;
            expect(fs.existsSync(res.testPath)).to.be.true;
            const wfContent = fs.readFileSync(res.filePath, "utf-8");
            expect(wfContent).to.include("OrderProcessingInput");
            expect(wfContent).to.include("orderProcessingWorkflow");
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("scaffolds typed step files via generateStep", () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "siglo-cli-step-test-"));
        try {
            const res = generateStep("authorize-payment", tempDir);
            expect(fs.existsSync(res.filePath)).to.be.true;
            expect(fs.existsSync(res.testPath)).to.be.true;
            const stepContent = fs.readFileSync(res.filePath, "utf-8");
            expect(stepContent).to.include("AuthorizePaymentInput");
            expect(stepContent).to.include("authorizePaymentStep");
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it("exports workflow diagrams via exportWorkflow", () => {
        const wf = flow(Step.create("s1", async () => ({})));
        const mermaid = exportWorkflow(wf, { format: "mermaid", direction: "LR" });
        expect(mermaid).to.include("flowchart LR");
        expect(mermaid).to.include("s1");

        const dot = exportWorkflow(wf, { format: "dot" });
        expect(dot).to.include("digraph");
        expect(dot).to.include("s1");

        const json = exportWorkflow(wf, { format: "json" });
        expect(JSON.parse(json)).to.have.property("name", "s1");
    });
    it('starts live monitoring server via startMonitor', async () => {
        const monitor = await startMonitor({ port: 0 });
        expect(monitor.port).to.be.a('number');
        expect(monitor.server).to.not.be.undefined;
        await monitor.close();
    });
    it('reconciles abandoned stacks via reconcileCommand', async () => {
        const staleTime = Date.now() - 10 * 60 * 1000;
        const dummyStacks = [
            { stackId: 'cli-stale-1', status: 'running', timestamp: staleTime, workflowId: 'wf-cli' },
            { stackId: 'cli-fresh-1', status: 'running', timestamp: Date.now(), workflowId: 'wf-cli' }
        ];

        // 1. Inspect
        const inspectReport = await reconcileCommand({
            staleThreshold: '5m',
            action: 'inspect',
            stacks: dummyStacks
        });
        expect(inspectReport.inspected).to.equal(2);
        expect(inspectReport.staleStacks).to.have.length(1);
        expect(inspectReport.staleStacks[0].stackId).to.equal('cli-stale-1');

        // 2. Fail
        const failReport = await reconcileCommand({
            staleThreshold: '5m',
            action: 'fail',
            stacks: dummyStacks
        });
        expect(failReport.reconciled).to.include('cli-stale-1');

        // 3. Compensate with flow
        let compensated = false;
        const mockFlow = {
            compensate: async (id: string) => {
                expect(id).to.equal('cli-stale-1');
                compensated = true;
                return { completed: ['step1'], failed: [] };
            }
        };

        const compReport = await reconcileCommand({
            staleThreshold: '5m',
            action: 'compensate',
            mode: 'best-effort',
            flow: mockFlow,
            stacks: dummyStacks
        });
        expect(compensated).to.be.true;
        expect(compReport.reconciled).to.include('cli-stale-1');
    });
});
