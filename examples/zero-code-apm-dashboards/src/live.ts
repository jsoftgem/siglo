import { setTimeout } from 'node:timers/promises';
import { createMonitorServer } from '@siglo/monitor';
import { runAllScenarios } from './index';
import { shutdownTelemetry } from './tracer';

async function main(): Promise<void> {
    // Listen on the host interface so Prometheus in Docker can scrape this process.
    const monitor = await createMonitorServer({
        port: 4000,
        host: '0.0.0.0',
        allowRemoteResume: false
    });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log('Live monitor: http://localhost:4000; metrics: http://localhost:4000/metrics');
    try {
        while (!controller.signal.aborted) {
            await runAllScenarios({ emitter: monitor.emitter });
            await setTimeout(5000, undefined, { signal: controller.signal }).catch(error => {
                if (error.name !== 'AbortError') throw error;
            });
        }
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        await monitor.close();
        await shutdownTelemetry();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
