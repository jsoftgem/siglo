import {
    recordInspection,
    stepInspectionStorage,
    resumeWorkflow,
    defaultDurableManager,
    getStorageAdapter,
    ValidationException,
    ExpiredWaitException,
    WorkflowAlreadyResumedException,
    DuplicateEventException,
    isPlainObject,
} from '@siglo/core';
import { getApprovalRevocationStore } from './approvals';
import { CallbackHandlerOptions } from './types';
import { ActionTokenPayload, verifyActionToken } from './tokens';
import { escapeHtml } from './transports';

export interface NotificationExpressRequestLike {
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    query?: Record<string, unknown>;
    body?: unknown;
}

export interface NotificationExpressResponseLike {
    setHeader(name: string, value: string): unknown;
    status(code: number): NotificationExpressResponseLike;
    end(): unknown;
    redirect(code: number, url: string): unknown;
    type(type: string): NotificationExpressResponseLike;
    send(body: unknown): unknown;
    json(body: unknown): unknown;
}

export interface NotificationFastifyRequestLike {
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    query?: unknown;
    body?: unknown;
}

export interface NotificationFastifyReplyLike {
    header(name: string, value: string): unknown;
    code(code: number): NotificationFastifyReplyLike;
    send(body?: unknown): unknown;
    redirect(url: string): unknown;
    type(type: string): NotificationFastifyReplyLike;
}

export interface NotificationHonoContextLike {
    req: {
        method: string;
        header(name: string): string | undefined;
        query(name: string): string | undefined;
        json(): Promise<unknown>;
        parseBody(): Promise<unknown>;
    };
    header(name: string, value: string): void;
    body(data: null, status: number): Response;
    redirect(url: string, status: number): Response;
    html(html: string, status: number): Response;
    json(data: unknown, status: number): Response;
}

export interface NotificationCallbackResponse {
    status: number;
    body: { message: string };
    redirect?: string;
}
export async function handleNotificationCallback(
    token: string,
    options: CallbackHandlerOptions,
): Promise<NotificationCallbackResponse> {
    let verified: ActionTokenPayload | undefined;
    const report = (
        approvalState: 'approved' | 'rejected' | 'forbidden' | 'cancelled' | 'expired' | 'conflict' | 'failed',
    ) => {
        // Never attribute an unverified token to a workflow or accept caller ambient scope.
        if (!verified?.inspection) return;
        stepInspectionStorage.run({ ...verified.inspection, stackId: verified.stackId, monitor: options.monitor }, () =>
            recordInspection({
                version: 1,
                kind: 'notification',
                approval: true,
                outcome: approvalState === 'approved' || approvalState === 'rejected' ? 'success' : 'failure',
                approvalState,
                approvalExpiresAt: verified!.expiresAt,
            }),
        );
    };
    try {
        const p = await verifyActionToken(token, options.signingSecret, { toleranceSeconds: options.toleranceSeconds });
        verified = p;
        if (!options.authorize && !options.allowBearerApproval) {
            report('forbidden');
            return { status: 403, body: { message: 'Authenticated approval required' } };
        }
        return await getApprovalRevocationStore().withApprovalLock(p.correlationKey, async () => {
            if (options.authorize && !(await options.authorize(p))) {
                report('forbidden');
                return { status: 403, body: { message: 'Approval forbidden' } };
            }
            if (await getApprovalRevocationStore().isRevoked(p.correlationKey)) {
                report('cancelled');
                return { status: 409, body: { message: 'Approval cancelled' } };
            }
            const adapter = getStorageAdapter();
            const record = adapter?.getWaitRecord
                ? await adapter.getWaitRecord(p.correlationKey)
                : defaultDurableManager.getWaiting(p.correlationKey);
            if (record && record.stackId !== p.stackId)
                throw new ValidationException([{ field: 'token', message: 'Approval workflow mismatch' }]);
            await resumeWorkflow(options.workflow, p.correlationKey, {
                approved: p.approved,
                event: { type: p.expectedEvent },
                expectedEvent: p.expectedEvent,
            });
            report(p.approved ? 'approved' : 'rejected');
            return { status: 200, body: { message: 'Approval recorded' }, redirect: options.onSuccessRedirect };
        });
    } catch (e) {
        const expired =
            e instanceof ExpiredWaitException || (e instanceof ValidationException && /expired/i.test(e.message));
        const conflict = e instanceof WorkflowAlreadyResumedException || e instanceof DuplicateEventException;
        const invalid = e instanceof ValidationException;
        report(conflict ? 'conflict' : expired ? 'expired' : 'failed');
        return {
            status: conflict ? 409 : expired ? 410 : invalid ? 400 : 500,
            body: {
                message: conflict
                    ? 'Approval already resolved'
                    : expired
                      ? 'Approval expired'
                      : invalid
                        ? 'Invalid approval'
                        : 'Unable to process approval',
            },
            redirect: expired ? options.onExpiredRedirect : options.onErrorRedirect,
        };
    }
}
export function renderApprovalConfirmation(result: NotificationCallbackResponse): string {
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(result.body.message)}</title><main><h1>${escapeHtml(result.body.message)}</h1><p>You may close this window.</p></main></html>`;
}
function headers(origin: string | undefined, options: CallbackHandlerOptions): Record<string, string> {
    return {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
        ...(origin && options.allowedOrigins?.includes(origin)
            ? {
                  'Access-Control-Allow-Origin': origin,
                  Vary: 'Origin',
                  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                  'Access-Control-Allow-Headers': 'Content-Type',
              }
            : {}),
    };
}
function tokenFrom(query: unknown, body: unknown): string {
    const qToken = isPlainObject(query) ? query.token : undefined;
    const bToken = isPlainObject(body) ? body.token : undefined;
    const token = qToken ?? bToken;
    return typeof token === 'string' ? token : '';
}
/** GET is a preview only. Mutation tokens are accepted exclusively from POST bodies. */
async function route(
    method: string,
    query: unknown,
    body: unknown,
    options: CallbackHandlerOptions,
    request: unknown,
    origin?: string,
): Promise<NotificationCallbackResponse & { html?: string }> {
    if (method === 'GET' || method === 'HEAD') {
        try {
            const token = tokenFrom(query, undefined);
            const p = await verifyActionToken(token, options.signingSecret, {
                toleranceSeconds: options.toleranceSeconds,
            });
            const message = p.approved ? 'Confirm approval' : 'Confirm rejection';
            return {
                status: 200,
                body: { message },
                html: `<!doctype html><html lang="en"><meta charset="utf-8"><title>${message}</title><main><h1>${message}</h1><form method="post" action="?"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">${message}</button></form></main></html>`,
            };
        } catch {
            return { status: 400, body: { message: 'Invalid approval' } };
        }
    }
    if (method !== 'POST') return { status: 405, body: { message: 'Method not allowed' } };
    if (origin && options.allowedOrigins && !options.allowedOrigins.includes(origin))
        return { status: 403, body: { message: 'Origin forbidden' } };
    // Authentication/CSRF middleware can inspect the original framework request.
    const authorize = options.authorize
        ? (payload: ActionTokenPayload) => options.authorize!(payload, request)
        : undefined;
    return handleNotificationCallback(tokenFrom(undefined, body), { ...options, authorize });
}
export function createNotificationExpressMiddleware(options: CallbackHandlerOptions) {
    return async (req: NotificationExpressRequestLike, res: NotificationExpressResponseLike): Promise<void> => {
        const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : undefined;
        for (const [key, value] of Object.entries(headers(origin, options))) res.setHeader(key, value);
        res.setHeader('Allow', 'GET, HEAD, POST, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        const r = await route(req.method || 'GET', req.query, req.body, options, req, origin);
        if (req.method === 'HEAD') {
            res.status(r.status).end();
            return;
        }
        if (r.redirect) res.redirect(303, r.redirect);
        else if (r.html || options.responseFormat === 'html')
            res.status(r.status)
                .type('html')
                .send(r.html ?? renderApprovalConfirmation(r));
        else res.status(r.status).json(r.body);
    };
}
export function createNotificationFastifyHandler(options: CallbackHandlerOptions) {
    return async (req: NotificationFastifyRequestLike, reply: NotificationFastifyReplyLike): Promise<void> => {
        const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : undefined;
        for (const [key, value] of Object.entries(headers(origin, options))) reply.header(key, value);
        reply.header('Allow', 'GET, HEAD, POST, OPTIONS');
        if (req.method === 'OPTIONS') {
            reply.code(204).send();
            return;
        }
        const r = await route(req.method || 'GET', req.query, req.body, options, req, origin);
        if (req.method === 'HEAD') {
            reply.code(r.status).send();
            return;
        }
        if (r.redirect) reply.code(303).redirect(r.redirect);
        else if (r.html || options.responseFormat === 'html')
            reply
                .code(r.status)
                .type('text/html')
                .send(r.html ?? renderApprovalConfirmation(r));
        else reply.code(r.status).send(r.body);
    };
}
export function createNotificationHonoHandler(options: CallbackHandlerOptions) {
    return async (c: NotificationHonoContextLike): Promise<Response> => {
        for (const [key, value] of Object.entries(headers(c.req.header('origin'), options))) c.header(key, value);
        c.header('Allow', 'GET, HEAD, POST, OPTIONS');
        if (c.req.method === 'OPTIONS') return c.body(null, 204);
        let body: unknown;
        if (c.req.method === 'POST') {
            try {
                body = c.req.header('content-type')?.includes('application/json')
                    ? await c.req.json()
                    : await c.req.parseBody();
            } catch {
                const r: NotificationCallbackResponse = { status: 400, body: { message: 'Invalid approval' } };
                return options.responseFormat === 'html'
                    ? c.html(renderApprovalConfirmation(r), r.status)
                    : c.json(r.body, r.status);
            }
        }
        const r = await route(c.req.method, { token: c.req.query('token') }, body, options, c, c.req.header('origin'));
        if (c.req.method === 'HEAD') return c.body(null, r.status);
        return r.redirect
            ? c.redirect(r.redirect, 303)
            : r.html || options.responseFormat === 'html'
              ? c.html(r.html ?? renderApprovalConfirmation(r), r.status)
              : c.json(r.body, r.status);
    };
}
