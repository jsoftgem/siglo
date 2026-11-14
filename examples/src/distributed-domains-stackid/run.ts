import { WorkflowEventEmitter, setDefaultMonitor } from '@siglo/core';
import { createMonitorServer, MonitorServerInstance } from '@siglo/monitor';
import { createFulfillmentService } from './fulfillment-service';
import { createOrderWorkflow, OrderInput } from './order-service';

export interface DemoRunOptions {
    port?: number;
    keepAlive?: boolean;
}

export async function runDistributedDemo(options: DemoRunOptions = {}): Promise<{
    monitorInstance: MonitorServerInstance;
    dashboardUrl: string;
    results: any[];
}> {
    const port = options.port !== undefined ? options.port : process.env.PORT ? parseInt(process.env.PORT, 10) : 4200;
    const emitter = new WorkflowEventEmitter();

    // Default monitor emitter ensures all steps and flows emit to this pipeline
    setDefaultMonitor(emitter);

    // Boot up the real live monitoring dashboard server
    const monitorInstance = await createMonitorServer({
        port,
        host: '127.0.0.1',
        emitter,
    });

    const dashboardUrl = `http://127.0.0.1:${monitorInstance.port}`;

    // Initialize Service B (Fulfillment Domain)
    const fulfillmentService = createFulfillmentService({ monitor: emitter });

    // Initialize Service A (Order Domain), injecting fulfillment client
    const orderWorkflow = createOrderWorkflow(fulfillmentService).monitor(emitter);

    console.log('\n================================================================');
    console.log('  Siglo Distributed Multi-Domain Workflow Demo');
    console.log('  Pattern: Parent-Child Correlated Workflows');
    console.log('  Live Dashboard: ' + dashboardUrl);
    console.log('================================================================\n');

    const results: any[] = [];

    // --- Scenario 1: Tenant "tenant_acme_retail" ---
    const acmeStackId = 'stack-acme-order-101';
    const acmeTenant = 'tenant_acme_retail';
    console.log(`[Service A: Order] Starting order for tenant "${acmeTenant}" with stackId: "${acmeStackId}"...`);

    const acmeOrderInput: OrderInput = {
        orderId: 'ORD-ACME-001',
        customerEmail: 'buyer@acme-retail.com',
        sku: 'mechanical-keyboard-rgb',
        quantity: 2,
        amountCents: 15998,
    };

    const acmeResult = await orderWorkflow.run(acmeOrderInput, {
        stackId: acmeStackId,
        namespace: acmeTenant,
        workflowId: 'order-processing-service',
        pojo: true,
    });
    results.push(acmeResult);

    console.log(
        `[Service A: Order] Completed order "${acmeOrderInput.orderId}". Tracking: ${acmeResult.fulfillment.trackingId}`,
    );
    console.log(` -> Parent Stack: "${acmeStackId}" (Order Service)`);
    console.log(` -> Child Stack:  "${acmeResult.childWorkflow.stackId}" (Fulfillment Service)\n`);

    // --- Scenario 2: Tenant "tenant_globex_corp" ---
    const globexStackId = 'stack-globex-order-202';
    const globexTenant = 'tenant_globex_corp';
    console.log(`[Service A: Order] Starting order for tenant "${globexTenant}" with stackId: "${globexStackId}"...`);

    const globexOrderInput: OrderInput = {
        orderId: 'ORD-GLOBEX-002',
        customerEmail: 'procurement@globex.com',
        sku: 'datacenter-switch-48p',
        quantity: 1,
        amountCents: 850000,
    };

    const globexResult = await orderWorkflow.run(globexOrderInput, {
        stackId: globexStackId,
        namespace: globexTenant,
        workflowId: 'order-processing-service',
        pojo: true,
    });
    results.push(globexResult);

    console.log(
        `[Service A: Order] Completed order "${globexOrderInput.orderId}". Tracking: ${globexResult.fulfillment.trackingId}`,
    );
    console.log(` -> Parent Stack: "${globexStackId}" (Order Service)`);
    console.log(` -> Child Stack:  "${globexResult.childWorkflow.stackId}" (Fulfillment Service)\n`);

    console.log('----------------------------------------------------------------');
    console.log('  HOW TO OBSERVE IN LIVE MONITORING:');
    console.log(`  1. Open ${dashboardUrl} in your browser.`);
    console.log('  2. Use the Tenant dropdown to switch between:');
    console.log('     "tenant_acme_retail" and "tenant_globex_corp".');
    console.log(`  3. Type "${acmeStackId}" in the search bar:`);
    console.log('     Both the parent order workflow AND child fulfillment workflow');
    console.log('     appear in the Run List because of correlated stack naming!');
    console.log('  4. Click "order-processing-service": inspect its connected 4-step DAG.');
    console.log('     Click step "order:dispatchToFulfillment" to see the childWorkflow output.');
    console.log('  5. Click "fulfillment-service": inspect its OWN connected 4-step DAG.');
    console.log('     (No steps relegated to "Other observed steps"!)');
    console.log('----------------------------------------------------------------\n');

    if (options.keepAlive) {
        console.log('Server is running. Press Ctrl+C to exit.\n');
        const shutdown = async () => {
            console.log('\nShutting down monitor server...');
            await monitorInstance.close();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }

    return { monitorInstance, dashboardUrl, results };
}

if (require.main === module) {
    runDistributedDemo({ keepAlive: true }).catch(err => {
        console.error('Demo error:', err);
        process.exit(1);
    });
}
