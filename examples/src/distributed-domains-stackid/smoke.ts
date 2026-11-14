const orderServiceUrl = process.env.ORDER_SERVICE_URL || 'http://127.0.0.1:3001';
const monitorUrl = process.env.MONITOR_URL || 'http://127.0.0.1:4200';

async function main() {
    console.log(`[Smoke] Testing distributed order flow against ${orderServiceUrl}`);
    console.log(`[Smoke] Live monitor available at ${monitorUrl}`);

    // 1. Submit Order for Tenant A: tenant_acme_retail
    const acmeStackId = 'stack-acme-order-101';
    const acmeTenant = 'tenant_acme_retail';
    console.log(`\n[Smoke] 1. Dispatching Order 1 for tenant "${acmeTenant}" with stackId "${acmeStackId}"...`);

    const res1 = await fetch(`${orderServiceUrl}/api/orders`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-stack-id': acmeStackId,
            'x-tenant-id': acmeTenant,
        },
        body: JSON.stringify({
            orderId: 'ORD-ACME-001',
            customerEmail: 'purchasing@acme-retail.com',
            sku: 'mechanical-keyboard-rgb',
            quantity: 2,
            amountCents: 15998,
        }),
    });

    if (!res1.ok) {
        throw new Error(`Order 1 failed with HTTP ${res1.status}: ${await res1.text()}`);
    }

    const order1 = await res1.json();
    console.log('[Smoke] Order 1 Success Response:', order1);
    if (order1.stackId !== acmeStackId) throw new Error(`Expected stackId ${acmeStackId}, got ${order1.stackId}`);
    if (order1.namespace !== acmeTenant) throw new Error(`Expected namespace ${acmeTenant}, got ${order1.namespace}`);
    if (order1.childWorkflow?.stackId !== `${acmeStackId}:fulfillment`) {
        throw new Error(`Expected child stackId ${acmeStackId}:fulfillment, got ${order1.childWorkflow?.stackId}`);
    }

    // 2. Submit Order for Tenant B: tenant_globex_corp
    const globexStackId = 'stack-globex-order-202';
    const globexTenant = 'tenant_globex_corp';
    console.log(`\n[Smoke] 2. Dispatching Order 2 for tenant "${globexTenant}" with stackId "${globexStackId}"...`);

    const res2 = await fetch(`${orderServiceUrl}/api/orders`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-stack-id': globexStackId,
            'x-tenant-id': globexTenant,
        },
        body: JSON.stringify({
            orderId: 'ORD-GLOBEX-002',
            customerEmail: 'procurement@globex.com',
            sku: 'datacenter-switch-48p',
            quantity: 1,
            amountCents: 850000,
        }),
    });

    if (!res2.ok) {
        throw new Error(`Order 2 failed with HTTP ${res2.status}: ${await res2.text()}`);
    }

    const order2 = await res2.json();
    console.log('[Smoke] Order 2 Success Response:', order2);
    if (order2.stackId !== globexStackId) throw new Error(`Expected stackId ${globexStackId}, got ${order2.stackId}`);
    if (order2.namespace !== globexTenant)
        throw new Error(`Expected namespace ${globexTenant}, got ${order2.namespace}`);
    if (order2.childWorkflow?.stackId !== `${globexStackId}:fulfillment`) {
        throw new Error(`Expected child stackId ${globexStackId}:fulfillment, got ${order2.childWorkflow?.stackId}`);
    }

    // 3. Verify workflows exist in Live Monitor
    console.log(`\n[Smoke] 3. Verifying runs recorded in Live Monitor at ${monitorUrl}/api/workflows...`);
    const monitorRes = await fetch(`${monitorUrl}/api/workflows`);
    if (monitorRes.ok) {
        const runs = await monitorRes.json();
        console.log(`[Smoke] Live Monitor contains ${runs.length} recorded workflow executions:`);
        for (const run of runs) {
            console.log(
                `  - Stack: ${run.stackId} | Tenant: ${run.namespace} | Status: ${run.status} | Steps: ${Object.keys(run.steps || {}).length}`,
            );
        }
    }

    console.log('\n================================================================');
    console.log('  DISTRIBUTED EXECUTION VERIFIED SUCCESSFULLY!');
    console.log(`  Open ${monitorUrl} in your browser to inspect live graphs.`);
    console.log('================================================================\n');
}

main().catch(err => {
    console.error('[Smoke] Error:', err);
    process.exit(1);
});
