import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Step, flow, parallel } from 'fluid-func';
import {
    visualizeWorkflow,
    validateWorkflow,
    inspectWorkflow,
    toTextGraph,
    initProject,
    replayFixture,
    inspectCheckpoint
} from './index';

describe('@fluid-func/cli Developer Tools Suite', () => {
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
            })).modern()
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
            Step.create('dummy', async () => ({ value: 100 })).modern()
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
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-cli-init-test-'));
        try {
            const res = initProject(tempDir);
            expect(res.filesCreated.length).to.equal(3);
            expect(fs.existsSync(path.join(tempDir, 'package.json'))).to.be.true;
            expect(fs.existsSync(path.join(tempDir, 'src/workflow.ts'))).to.be.true;
            expect(fs.existsSync(path.join(tempDir, 'src/workflow.test.ts'))).to.be.true;
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
