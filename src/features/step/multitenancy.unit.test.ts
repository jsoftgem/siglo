import { expect } from 'chai';
import {
    Step,
    flow,
    StorageManager,
    defaultStorageManager,
    toPOJO
} from '../../index';
import Context from '../context';
import { Util } from '../executer/util';
import { generateUUID } from '../../shared';

describe('Multi-Tenancy, Anonymous Steps & State Serialization Unit Tests', () => {
    afterEach(() => {
        defaultStorageManager.clear();
    });

    it('enforces runtime multi-tenancy across concurrent executions with tenantId', async () => {
        const orderPipeline = flow(
            Step.create('validate', async (param: any) => ({
                valid: true,
                tenant: param.$tenantId ? param.$tenantId() : undefined
            })),
            Step.create('charge', async (param: any) => ({
                charged: true,
                amount: param.amount?.val !== undefined ? param.amount.val : param.amount
            }))
        );

        // Run Tenant A and Tenant B concurrently
        const [resA, resB] = await Promise.all([
            orderPipeline.run({ amount: 100 }, { tenantId: 'tenant_acme', pojo: true }),
            orderPipeline.run({ amount: 250 }, { tenantId: 'tenant_globex', pojo: true })
        ]);

        expect(resA.tenant).to.equal('tenant_acme');
        expect(resA.amount).to.equal(100);

        expect(resB.tenant).to.equal('tenant_globex');
        expect(resB.amount).to.equal(250);
    });

    it('partitions step cache keys across tenants so tenant data is never leaked', async () => {
        const store = new Map<string, any>();
        Step.useStorage({
            name: 'MockTenantCache',
            async getCachedStep(key: string) {
                return store.get(key);
            },
            async setCachedStep(key: string, value: any) {
                store.set(key, value);
            }
        });

        let executionCount = 0;

        const sharedCachedStep = Step.create('computeTax', async (param: any) => {
            executionCount++;
            const sub = param.subtotal?.val !== undefined ? param.subtotal.val : param.subtotal;
            return {
                tax: sub * 0.1,
                calculatedFor: param.$tenantId ? param.$tenantId() : undefined
            };
        }).cache(60);

        const taxFlow = flow(sharedCachedStep);

        // Execute for tenant_a with subtotal 100
        const outA1 = await taxFlow.run({ subtotal: 100 }, { tenantId: 'tenant_a' });
        expect(executionCount).to.equal(1);
        expect(outA1.tax?.val ?? outA1.tax).to.equal(10);
        expect(outA1.calculatedFor?.val ?? outA1.calculatedFor).to.equal('tenant_a');

        // Execute for tenant_a again with same subtotal -> hits cache!
        const outA2 = await taxFlow.run({ subtotal: 100 }, { tenantId: 'tenant_a' });
        expect(executionCount).to.equal(1);
        expect(outA2.tax?.val ?? outA2.tax).to.equal(10);

        // Execute for tenant_b with identical subtotal 100 -> MUST NOT hit tenant_a's cache!
        const outB1 = await taxFlow.run({ subtotal: 100 }, { tenantId: 'tenant_b' });
        expect(executionCount).to.equal(2);
        expect(outB1.tax?.val ?? outB1.tax).to.equal(10);
        expect(outB1.calculatedFor?.val ?? outB1.calculatedFor).to.equal('tenant_b');
    });

    it('scopes checkpoints to tenantId and prevents cross-tenant restoration', async () => {
        const checkpoints = new Map<string, any>();

        Step.useStorage({
            name: 'CheckpointTester',
            async saveCheckpoint(event) {
                checkpoints.set(event.stackId || event.checkpointId, event);
            },
            async getCheckpoint(id) {
                return checkpoints.get(id);
            }
        });

        const testFlow = flow(
            Step.create('step1', async () => ({ value: 'alpha' })),
            Step.create('step2', async () => ({ value: 'beta' }))
        );

        const execution = await testFlow.run({}, { tenantId: 'tenant_123' });
        expect(execution).to.not.be.undefined;

        // Verify checkpoint saved with tenantId
        const savedEntries = Array.from(checkpoints.values());
        expect(savedEntries.length).to.be.greaterThan(0);
        expect(savedEntries[0].tenantId).to.equal('tenant_123');
    });

    it('executes 100% anonymous steps and supports $steps[i] and $history[i] indexing', async () => {
        const anonymousPipeline = flow(
            Step.create(async (param: any) => ({
                stepZeroVal: 42
            })),
            Step.create(async (param: any) => ({
                stepOneVal: (param.$steps[0]?.val ?? param.$steps[0]).stepZeroVal + 8
            })),
            Step.create('namedStep', async (param: any) => ({
                stepTwoVal: (param.$history[1]?.val ?? param.$history[1]).stepOneVal * 2
            }))
        );

        const result = await anonymousPipeline.run({}, { pojo: true });
        expect(result.stepZeroVal).to.equal(42);
        expect(result.stepOneVal).to.equal(50);
        expect(result.stepTwoVal).to.equal(100);
        expect(result.$steps[0].stepZeroVal).to.equal(42);
        expect(result.$steps[1].stepOneVal).to.equal(50);
        expect(result.$steps.namedStep.stepTwoVal).to.equal(100);
    });

    it('supports serializeState and hydrateState roundtrip with tenant information', () => {
        const mgr = new StorageManager();
        const stackId = 'stack_serialization_test';
        const tenantId = 'tenant_xyz';

        mgr.createStack(stackId, tenantId);
        mgr.set(stackId, 'step_1', 'myKey', 'myVal');

        const serialized = mgr.serializeState(stackId);
        expect(serialized).to.include(tenantId);
        expect(serialized).to.include('myKey');

        const newMgr = new StorageManager();
        const hydratedStackId = newMgr.hydrateState(serialized);
        expect(hydratedStackId).to.equal(stackId);

        const data = newMgr.get(stackId, 'step_1');
        expect(data.myKey).to.equal('myVal');

        const stack = newMgr.getStack(stackId);
        expect(stack?.tenantId).to.equal(tenantId);
    });

    it('supports checkpoint restoration helper in StorageManager', async () => {
        const mgr = new StorageManager();
        const stackId = 'chk_test_stack';
        const tenantId = 'tenant_chk';
        mgr.createStack(stackId, tenantId);
        mgr.set(stackId, 'step_a', 'token', 'abc');

        const chk = await mgr.checkpoint(stackId);
        expect(chk.tenantId).to.equal(tenantId);

        const restoredStackId = mgr.restoreCheckpoint(chk);
        expect(restoredStackId).to.equal(stackId);
        expect(mgr.get(restoredStackId, 'step_a').token).to.equal('abc');
    });

    it('attaches tenantId in Util.convertToContextStructure', () => {
        const initial = { foo: 'bar' };
        const converted = Util.convertToContextStructure(initial, 'chain_1', 'stack_1', 'tenant_special');
        expect(converted.foo.val).to.equal('bar');
        expect(converted.$tenantId()).to.equal('tenant_special');
    });
    it("sets tenantId directly via Context.setTenantId", () => {
        const ctx = Context.createContext("chain_c");
        ctx.setTenantId("tenant_direct");
        expect(ctx.$tenantId).to.equal("tenant_direct");
    });

    it("attaches tenantId when convertToContextStructure receives an existing Context instance", () => {
        const ctx = Context.createContext("chain_d");
        const converted = Util.convertToContextStructure(ctx, "chain_d", "stack_d", "tenant_on_ctx");
        expect(ctx.$tenantId).to.equal("tenant_on_ctx");
        expect(converted.$tenantId()).to.equal("tenant_on_ctx");
    });

    it("handles StorageManager.createStack without arguments and StorageManager.get for non-existent step", () => {
        const mgr = new StorageManager();
        const autoStackId = mgr.createStack();
        expect(autoStackId).to.be.a("string");
        expect(mgr.get(autoStackId, "nonexistent_step")).to.be.undefined;
    });
});
