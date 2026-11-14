import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runDistributedDemo } from './run';

describe('Distributed Multi-Domain Services Workflow: Parent-Child Correlated Workflows', () => {
    it('correlates Order & Fulfillment processes across services with separate, connected DAGs', async () => {
        // Run with port 0 (ephemeral port) and keepAlive: false for automated testing
        const { monitorInstance, results } = await runDistributedDemo({ port: 0, keepAlive: false });

        try {
            assert.equal(results.length, 2);

            const [acmeResult, globexResult] = results;

            // 1. Verify workflow execution outputs
            assert.equal(acmeResult.orderId, 'ORD-ACME-001');
            assert.equal(acmeResult.status, 'CONFIRMED');
            assert.equal(acmeResult.$stackId, 'stack-acme-order-101');
            assert.equal(acmeResult.namespace, 'tenant_acme_retail');
            assert.equal(acmeResult.childWorkflow.stackId, 'stack-acme-order-101:fulfillment');
            assert.equal(acmeResult.childWorkflow.parentStackId, 'stack-acme-order-101');
            assert.ok(acmeResult.fulfillment.trackingId.includes('ORD-ACME-001'));

            assert.equal(globexResult.orderId, 'ORD-GLOBEX-002');
            assert.equal(globexResult.status, 'CONFIRMED');
            assert.equal(globexResult.$stackId, 'stack-globex-order-202');
            assert.equal(globexResult.namespace, 'tenant_globex_corp');
            assert.equal(globexResult.childWorkflow.stackId, 'stack-globex-order-202:fulfillment');
            assert.equal(globexResult.childWorkflow.parentStackId, 'stack-globex-order-202');
            assert.ok(globexResult.fulfillment.trackingId.includes('ORD-GLOBEX-002'));

            // 2. Verify Monitor Store contains BOTH Parent and Child runs distinctly
            const acmeOrderRun = monitorInstance.store.getRun('stack-acme-order-101');
            assert.ok(acmeOrderRun, 'Parent order run should exist in monitor store');
            assert.equal(acmeOrderRun.flowName, 'order-processing-service');
            assert.equal(acmeOrderRun.namespace, 'tenant_acme_retail');

            const acmeFulfillmentRun = monitorInstance.store.getRun('stack-acme-order-101:fulfillment');
            assert.ok(acmeFulfillmentRun, 'Child fulfillment run should exist in monitor store');
            assert.equal(acmeFulfillmentRun.flowName, 'fulfillment-service');
            assert.equal(acmeFulfillmentRun.namespace, 'tenant_acme_retail');

            // 3. Verify Order run contains ONLY Order steps with its own clean DAG
            const orderStepNames = Object.values(acmeOrderRun.steps).map(s => s.stepName);
            assert.equal(orderStepNames.length, 4);
            assert.ok(orderStepNames.includes('order:validate'));
            assert.ok(orderStepNames.includes('order:createRecord'));
            assert.ok(orderStepNames.includes('order:dispatchToFulfillment'));
            assert.ok(orderStepNames.includes('order:finalizeOrder'));

            // 4. Verify Fulfillment run contains ONLY Fulfillment steps with its own clean DAG
            const fulfillmentStepNames = Object.values(acmeFulfillmentRun.steps).map(s => s.stepName);
            assert.equal(fulfillmentStepNames.length, 4);
            assert.ok(fulfillmentStepNames.includes('fulfillment:checkInventory'));
            assert.ok(fulfillmentStepNames.includes('fulfillment:reserveStock'));
            assert.ok(fulfillmentStepNames.includes('fulfillment:chargePayment'));
            assert.ok(fulfillmentStepNames.includes('fulfillment:generateShippingLabel'));

            // 5. Verify all steps completed successfully
            for (const step of Object.values(acmeOrderRun.steps)) {
                assert.equal(step.status, 'COMPLETED');
            }
            for (const step of Object.values(acmeFulfillmentRun.steps)) {
                assert.equal(step.status, 'COMPLETED');
            }

            // 6. Verify multi-tenant namespace filtering returns both parent and child runs for that tenant
            const acmeRuns = monitorInstance.store.listRuns({ namespace: 'tenant_acme_retail' });
            assert.equal(acmeRuns.length, 2);
            assert.ok(acmeRuns.some(r => r.stackId === 'stack-acme-order-101'));
            assert.ok(acmeRuns.some(r => r.stackId === 'stack-acme-order-101:fulfillment'));

            const globexRuns = monitorInstance.store.listRuns({ namespace: 'tenant_globex_corp' });
            assert.equal(globexRuns.length, 2);
            assert.ok(globexRuns.some(r => r.stackId === 'stack-globex-order-202'));
            assert.ok(globexRuns.some(r => r.stackId === 'stack-globex-order-202:fulfillment'));
        } finally {
            await monitorInstance.close();
        }
    });
});
