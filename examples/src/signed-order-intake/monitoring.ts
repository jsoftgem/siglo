import { getDefaultMonitor, setDefaultMonitor, WorkflowEventEmitter } from '@siglo/core';
import { createMonitorServer } from '@siglo/monitor';

/** Both workflows execute in this process, so no Redis transport is needed. */
export async function startLiveMonitor(
    port = Number(process.env.SIGNED_ORDER_MONITOR_PORT ?? 4500),
    emitter?: WorkflowEventEmitter,
) {
    const monitor = await createMonitorServer({
        port,
        host: '127.0.0.1',
        allowRemoteResume: false,
        emitter,
        redaction: { redactKeys: ['nonce', 'publicKey', 'keyId', 'signature-input', 'content-digest'] },
    });
    const previousMonitor = getDefaultMonitor();
    // Nested branch/when targets also need the same emitter.
    setDefaultMonitor(monitor.emitter);
    console.log(`Signed order live monitor: http://127.0.0.1:${monitor.port}`);
    return {
        ...monitor,
        async close() {
            setDefaultMonitor(previousMonitor);
            await monitor.close();
        },
    };
}
