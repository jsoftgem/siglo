import { IncomingMessage, ServerResponse } from 'http';
import { resumeWorkflow, defaultDurableManager } from '@siglo/core';
import { CloudSchedulerWebhookOptions, WebhookHandler } from './types';

/**
 * Creates an HTTP request handler for webhook-based schedulers such as
 * AWS EventBridge Scheduler, Google Cloud Tasks, or Cloudflare Queues.
 */
export function createSchedulerWebhookHandler(options: CloudSchedulerWebhookOptions): WebhookHandler {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
        }

        // Validate auth token if configured
        if (options.secretToken) {
            const authHeader = req.headers['authorization'];
            const customToken = req.headers['x-siglo-token'];
            let provided = typeof customToken === 'string' ? customToken.trim() : undefined;
            if (!provided && authHeader) {
                provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
            }

            if (provided !== options.secretToken) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: invalid scheduler token' }));
                return;
            }
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            try {
                const parsed = body ? JSON.parse(body) : {};
                const stackId = parsed.stackId || parsed.correlationKey;
                if (!stackId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required stackId or correlationKey in dispatch payload' }));
                    return;
                }

                const flow = options.flowLookup(parsed.workflowId, stackId);
                if (!flow) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Workflow definition for '${stackId}' not found` }));
                    return;
                }

                if (!defaultDurableManager.getWaitingByStack(stackId) && !defaultDurableManager.getWaiting(stackId)) {
                    defaultDurableManager.registerWait({
                        correlationKey: stackId,
                        stackId,
                        eventName: 'timer',
                        stepId: 'timer',
                        status: 'waiting',
                        createdAt: Date.now(),
                        continuationStepIndex: 0
                    });
                }

                const result = await resumeWorkflow(flow, stackId, parsed.payload || {
                    event: { type: 'timer:expired', timestamp: Date.now() }
                }, { allowExpired: true });

                if (options.onResumed) {
                    await options.onResumed(stackId, result);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, stackId }));
            } catch (err: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err?.message || String(err) }));
            }
        });
    };
}
