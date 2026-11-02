import { defaultDurableManager, resumeWorkflow, defaultStorageManager } from 'siglo';
import { MemoryPollerOptions, PollerReport, WaitRecord } from './types';

export class MemoryWaitPoller {
    private pollIntervalMs: number;
    private flowLookup?: MemoryPollerOptions['flowLookup'];
    private onResumed?: MemoryPollerOptions['onResumed'];
    private onFailed?: MemoryPollerOptions['onFailed'];
    private timer?: NodeJS.Timeout;
    private running: boolean = false;
    private inFlight: boolean = false;

    constructor(options: MemoryPollerOptions = {}) {
        this.pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0 ? options.pollIntervalMs : 1000;
        this.flowLookup = options.flowLookup;
        this.onResumed = options.onResumed;
        this.onFailed = options.onFailed;
    }

    /**
     * Executes a single poll over in-memory waiting workflows and expired checkpoints.
     */
    async pollOnce(): Promise<PollerReport> {
        const report: PollerReport = {
            claimed: 0,
            resumed: 0,
            failed: 0
        };

        const now = Date.now();
        const waitingRecords = typeof (defaultDurableManager as any).getAllWaiting === "function" ? (defaultDurableManager as any).getAllWaiting() : [];

        for (const waiting of waitingRecords) {
            if (waiting.expiresAt && waiting.expiresAt <= now) {
                report.claimed++;
                const waitRec: WaitRecord = {
                    correlationKey: waiting.correlationKey,
                    stackId: waiting.stackId,
                    namespace: waiting.namespace,
                    eventName: waiting.eventName,
                    status: 'RESUMING',
                    expiresAt: waiting.expiresAt,
                    continuationStepIndex: waiting.continuationStepIndex,
                    version: waiting.version
                };

                try {
                    const targetFlow = this.flowLookup?.(waiting.version, waiting.stackId);
                    let result: any;
                    if (targetFlow) {
                        result = await resumeWorkflow(targetFlow, waiting.stackId, {
                            event: { type: 'timer:expired', timestamp: now }
                        }, { allowExpired: true });
                    } else {
                        result = defaultDurableManager.resumeWait(waiting.correlationKey, true);
                    }

                    if (this.onResumed) {
                        await this.onResumed(waitRec, result);
                    }
                    report.resumed++;
                } catch (err: any) {
                    if (this.onFailed) {
                        await this.onFailed(waitRec, err);
                    }
                    report.failed++;
                }
            }
        }

        return report;
    }

    start(): void {
        if (this.running) return;
        this.running = true;

        const loop = async () => {
            if (!this.running) return;
            if (!this.inFlight) {
                this.inFlight = true;
                try {
                    await this.pollOnce();
                } catch {
                    // Swallow transient polling errors
                } finally {
                    this.inFlight = false;
                }
            }
            if (this.running) {
                this.timer = setTimeout(loop, this.pollIntervalMs);
            }
        };

        this.timer = setTimeout(loop, this.pollIntervalMs);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        while (this.inFlight) {
            await new Promise(r => setTimeout(r, 10));
        }
    }

    isRunning(): boolean {
        return this.running;
    }
}
