import { createHash, timingSafeEqual } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { resumeWorkflow, defaultDurableManager, getErrorMessage, isPlainObject } from '@siglo/core';
import { CloudSchedulerWebhookOptions, WebhookHandler } from './types';

function tokensEqual(provided: string | undefined, expected: string): boolean {
    if (!provided) return false;
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

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
            if (!provided && typeof authHeader === 'string') {
                provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
            }

            if (!tokensEqual(provided, options.secretToken)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: invalid scheduler token' }));
                return;
            }
        }

        let body = '';
        req.on('data', (chunk: Buffer | string) => {
            body += chunk;
        });

        req.on('error', (err: unknown) => {
            if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: getErrorMessage(err) }));
            }
        });

        req.on('end', async () => {
            try {
                let parsed: unknown = {};
                if (body) {
                    try {
                        parsed = JSON.parse(body);
                    } catch {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid JSON dispatch payload' }));
                        return;
                    }
                }
                if (!isPlainObject(parsed)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dispatch payload must be a JSON object' }));
                    return;
                }
                const rawStackId = parsed.stackId ?? parsed.correlationKey;
                const stackId = typeof rawStackId === 'string' && rawStackId.length > 0 ? rawStackId : undefined;
                if (!stackId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({ error: 'Missing required stackId or correlationKey in dispatch payload' }),
                    );
                    return;
                }

                const workflowId = typeof parsed.workflowId === 'string' ? parsed.workflowId : undefined;
                const flow = options.flowLookup(workflowId, stackId);
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
                        continuationStepIndex: 0,
                    });
                }

                const result = await resumeWorkflow(
                    flow,
                    stackId,
                    isPlainObject(parsed.payload)
                        ? parsed.payload
                        : {
                              event: { type: 'timer:expired', timestamp: Date.now() },
                          },
                    { allowExpired: true },
                );

                if (options.onResumed) {
                    await options.onResumed(stackId, result);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, stackId }));
            } catch (err: unknown) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: getErrorMessage(err) }));
            }
        });
    };
}
