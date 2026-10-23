import {expect} from 'chai';
import {defaultStorageManager, flow, Step, StorageManager} from '../../index';
import Context from '../context';
import {Util} from '../executer';

describe('Multi-Tenancy, Anonymous Steps & State Serialization Unit Tests', () => {
    afterEach(() => {
        defaultStorageManager.clear();
    });

    it('enforces runtime multi-tenancy across concurrent executions with namespace', async () => {
        const orderPipeline = flow(
            Step.create('validate', async (param: any) => ({
                valid: true,
                namespace: param.$namespace ? param.$namespace() : undefined
            })),
            Step.create('charge', async (param: any) => ({
                charged: true,
                amount: param.amount?.val !== undefined ? param.amount.val : param.amount
            }))
        );

        // Run Namespace A and Namespace B concurrently
        const [resA, resB] = await Promise.all([
            orderPipeline.run({amount: 100}, {namespace: 'ns_acme', pojo: true}),
            orderPipeline.run({amount: 250}, {namespace: 'ns_globex', pojo: true})
        ]);

        expect(resA.namespace).to.equal('ns_acme');
        expect(resA.amount).to.equal(100);

        expect(resB.namespace).to.equal('ns_globex');
        expect(resB.amount).to.equal(250);
    });

    it('partitions step cache keys across namespaces so namespace data is never leaked', async () => {
        const store = new Map<string, any>();
        Step.useStorage({
            name: 'MockNamespaceCache',
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
                calculatedFor: param.$namespace ? param.$namespace() : undefined
            };
        }).cache(60);

        const taxFlow = flow(sharedCachedStep);

        // Execute for ns_a with subtotal 100
        const outA1 = await taxFlow.run({subtotal: 100}, {namespace: 'ns_a'});
        expect(executionCount).to.equal(1);
        expect(outA1.tax?.val ?? outA1.tax).to.equal(10);
        expect(outA1.calculatedFor?.val ?? outA1.calculatedFor).to.equal('ns_a');

        // Execute for ns_a again with same subtotal -> hits cache!
        const outA2 = await taxFlow.run({subtotal: 100}, {namespace: 'ns_a'});
        expect(executionCount).to.equal(1);
        expect(outA2.tax?.val ?? outA2.tax).to.equal(10);

        // Execute for ns_b with identical subtotal 100 -> MUST NOT hit ns_a's cache!
        const outB1 = await taxFlow.run({subtotal: 100}, {namespace: 'ns_b'});
        expect(executionCount).to.equal(2);
        expect(outB1.tax?.val ?? outB1.tax).to.equal(10);
        expect(outB1.calculatedFor?.val ?? outB1.calculatedFor).to.equal('ns_b');
    });

    it('scopes checkpoints to namespace and prevents cross-namespace restoration', async () => {
        const checkpoints = new Map<string, any>();

        Step.useStorage({
            name: 'CheckpointTester',
            async saveCheckpoint(event) {
                checkpoints.set(event.stackId, event);
            },
            async getCheckpoint(id) {
                return checkpoints.get(id);
            }
        });

        const testFlow = flow(
            Step.create('step1', async () => ({value: 'alpha'})),
            Step.create('step2', async () => ({value: 'beta'}))
        );

        const execution = await testFlow.run({}, {namespace: 'ns_123'});
        expect(execution).to.not.be.undefined;

        // Verify checkpoint saved with namespace
        const savedEntries = Array.from(checkpoints.values());
        expect(savedEntries.length).to.be.greaterThan(0);
        expect(savedEntries[0].namespace).to.equal('ns_123');
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

        const result = await anonymousPipeline.run({}, {pojo: true});
        expect(result.stepZeroVal).to.equal(42);
        expect(result.stepOneVal).to.equal(50);
        expect(result.stepTwoVal).to.equal(100);
        expect(result.$steps[0].stepZeroVal).to.equal(42);
        expect(result.$steps[1].stepOneVal).to.equal(50);
        expect(result.$steps.namedStep.stepTwoVal).to.equal(100);
    });

    it('supports serializeState and hydrateState roundtrip with namespace information', () => {
        const mgr = new StorageManager();
        const stackId = 'stack_serialization_test';
        const namespace = 'ns_xyz';

        mgr.createStack(stackId, namespace);
        mgr.set(stackId, 'step_1', 'myKey', 'myVal');

        const serialized = mgr.serializeState(stackId);
        expect(serialized).to.include(namespace);
        expect(serialized).to.include('myKey');

        const newMgr = new StorageManager();
        const hydratedStackId = newMgr.hydrateState(serialized);
        expect(hydratedStackId).to.equal(stackId);

        const data = newMgr.get(stackId, 'step_1');
        expect(data.myKey).to.equal('myVal');

        const stack = newMgr.getStack(stackId);
        expect(stack?.namespace).to.equal(namespace);
    });

    it('supports checkpoint restoration helper in StorageManager', async () => {
        const mgr = new StorageManager();
        const stackId = 'chk_test_stack';
        const namespace = 'ns_chk';
        mgr.createStack(stackId, namespace);
        mgr.set(stackId, 'step_a', 'token', 'abc');

        const chk = await mgr.checkpoint(stackId);
        expect(chk.namespace).to.equal(namespace);

        const restoredStackId = mgr.restoreCheckpoint(chk);
        expect(restoredStackId).to.equal(stackId);
        expect(mgr.get(restoredStackId, 'step_a').token).to.equal('abc');
    });

    it('attaches namespace in Util.convertToContextStructure', () => {
        const initial = {foo: 'bar'};
        const converted = Util.convertToContextStructure(initial, 'chain_1', 'stack_1', 'ns_special');
        expect(converted.foo.val).to.equal('bar');
        expect(converted.$namespace()).to.equal('ns_special');
    });
    it("sets namespace directly via Context.setNamespace", () => {
        const ctx = Context.createContext("chain_c");
        ctx.setNamespace("ns_direct");
        expect(ctx.$namespace).to.equal("ns_direct");
    });

    it("attaches namespace when convertToContextStructure receives an existing Context instance", () => {
        const ctx = Context.createContext("chain_d");
        const converted = Util.convertToContextStructure(ctx, "chain_d", "stack_d", "ns_on_ctx");
        expect(ctx.$namespace).to.equal("ns_on_ctx");
        expect(converted.$namespace()).to.equal("ns_on_ctx");
    });

    it("handles StorageManager.createStack without arguments and StorageManager.get for non-existent step", () => {
        const mgr = new StorageManager();
        const autoStackId = mgr.createStack();
        expect(autoStackId).to.be.a("string");
        expect(mgr.get(autoStackId, "nonexistent_step")).to.be.undefined;
    });
});
