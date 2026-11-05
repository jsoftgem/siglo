import { recordInspection, stepInspectionStorage, resumeWorkflow, defaultDurableManager, getStorageAdapter, ValidationException, ExpiredWaitException, WorkflowAlreadyResumedException, DuplicateEventException } from 'siglo';
import { getApprovalRevocationStore } from './approvals';
import { CallbackHandlerOptions } from './types';
import { ActionTokenPayload, verifyActionToken } from './tokens';
import { escapeHtml } from './transports';
export interface NotificationCallbackResponse {
  status: number;
  body: { message: string };
  redirect?: string;
}
export async function handleNotificationCallback(token: string, options: CallbackHandlerOptions): Promise<NotificationCallbackResponse> {
  let verified: ActionTokenPayload | undefined;
  const report = (approvalState: 'approved' | 'rejected' | 'forbidden' | 'cancelled' | 'expired' | 'conflict' | 'failed') => {
    // Never attribute an unverified token to a workflow or accept caller ambient scope.
    if (!verified?.inspection) return;
    stepInspectionStorage.run({ ...verified.inspection, stackId: verified.stackId, monitor: options.monitor }, () =>
      recordInspection({ version: 1, kind: 'notification', approval: true,
        outcome: approvalState === 'approved' || approvalState === 'rejected' ? 'success' : 'failure',
        approvalState, approvalExpiresAt: verified!.expiresAt }));
  };
  try {
    const p = await verifyActionToken(token, options.signingSecret, { toleranceSeconds: options.toleranceSeconds });
    verified = p;
    if (!options.authorize && !options.allowBearerApproval) { report('forbidden'); return { status: 403, body: { message: 'Authenticated approval required' } }; }
    return await getApprovalRevocationStore().withApprovalLock(p.correlationKey, async () => {
      if (options.authorize && !await options.authorize(p)) { report('forbidden'); return { status: 403, body: { message: 'Approval forbidden' } }; }
      if (await getApprovalRevocationStore().isRevoked(p.correlationKey)) { report('cancelled'); return { status: 409, body: { message: 'Approval cancelled' } }; }
      const adapter = getStorageAdapter();
      const record = adapter?.getWaitRecord ? await adapter.getWaitRecord(p.correlationKey) : defaultDurableManager.getWaiting(p.correlationKey);
      if (record && record.stackId !== p.stackId) throw new ValidationException([{ field: 'token', message: 'Approval workflow mismatch' }]);
      await resumeWorkflow(options.workflow, p.correlationKey, { approved: p.approved, event: { type: p.expectedEvent }, expectedEvent: p.expectedEvent });
      report(p.approved ? 'approved' : 'rejected');
      return { status: 200, body: { message: 'Approval recorded' }, redirect: options.onSuccessRedirect };
    });
  } catch (e) {
    const expired = e instanceof ExpiredWaitException || (e instanceof ValidationException && /expired/i.test(e.message));
    const conflict = e instanceof WorkflowAlreadyResumedException || e instanceof DuplicateEventException;
    const invalid = e instanceof ValidationException;
    report(conflict ? 'conflict' : expired ? 'expired' : 'failed');
    return { status: conflict ? 409 : expired ? 410 : invalid ? 400 : 500, body: { message: conflict ? 'Approval already resolved' : expired ? 'Approval expired' : invalid ? 'Invalid approval' : 'Unable to process approval' }, redirect: expired ? options.onExpiredRedirect : options.onErrorRedirect };
  }
}
export function renderApprovalConfirmation(result: NotificationCallbackResponse): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(result.body.message)}</title><main><h1>${escapeHtml(result.body.message)}</h1><p>You may close this window.</p></main></html>`;
}
function headers(origin: string | undefined, options: CallbackHandlerOptions): Record<string, string> {
  return { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'", ...(origin && options.allowedOrigins?.includes(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } : {}) };
}
function tokenFrom(query: any, body: any): string {
  const token = query?.token ?? body?.token;
  return typeof token === 'string' ? token : '';
}
/** GET is a preview only. Mutation tokens are accepted exclusively from POST bodies. */
async function route(method: string, query: any, body: any, options: CallbackHandlerOptions, request: any, origin?: string): Promise<NotificationCallbackResponse & { html?: string }> {
  if (method === 'GET' || method === 'HEAD') {
    try {
      const token = tokenFrom(query, undefined);
      const p = await verifyActionToken(token, options.signingSecret, { toleranceSeconds: options.toleranceSeconds });
      const message = p.approved ? 'Confirm approval' : 'Confirm rejection';
      return { status: 200, body: { message }, html: `<!doctype html><html lang="en"><meta charset="utf-8"><title>${message}</title><main><h1>${message}</h1><form method="post" action="?"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">${message}</button></form></main></html>` };
    } catch { return { status: 400, body: { message: 'Invalid approval' } }; }
  }
  if (method !== 'POST') return { status: 405, body: { message: 'Method not allowed' } };
  if (origin && options.allowedOrigins && !options.allowedOrigins.includes(origin)) return { status: 403, body: { message: 'Origin forbidden' } };
  // Authentication/CSRF middleware can inspect the original framework request.
  const authorize = options.authorize ? (payload: any) => options.authorize!(payload, request) : undefined;
  return handleNotificationCallback(tokenFrom(undefined, body), { ...options, authorize });
}
export function createNotificationExpressMiddleware(options: CallbackHandlerOptions) {
  return async (req: any, res: any): Promise<void> => {
    for (const [key, value] of Object.entries(headers(req.headers?.origin, options))) res.setHeader(key, value);
    res.setHeader('Allow', 'GET, HEAD, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    const r = await route(req.method, req.query, req.body, options, req, req.headers?.origin);
    if (req.method === 'HEAD') { res.status(r.status).end(); return; }
    if (r.redirect) res.redirect(303, r.redirect);
    else if (r.html || options.responseFormat === 'html') res.status(r.status).type('html').send(r.html ?? renderApprovalConfirmation(r));
    else res.status(r.status).json(r.body);
  };
}
export function createNotificationFastifyHandler(options: CallbackHandlerOptions) {
  return async (req: any, reply: any): Promise<void> => {
    for (const [key, value] of Object.entries(headers(req.headers?.origin, options))) reply.header(key, value);
    reply.header('Allow', 'GET, HEAD, POST, OPTIONS');
    if (req.method === 'OPTIONS') { reply.code(204).send(); return; }
    const r = await route(req.method, req.query, req.body, options, req, req.headers?.origin);
    if (req.method === 'HEAD') { reply.code(r.status).send(); return; }
    if (r.redirect) reply.code(303).redirect(r.redirect);
    else if (r.html || options.responseFormat === 'html') reply.code(r.status).type('text/html').send(r.html ?? renderApprovalConfirmation(r));
    else reply.code(r.status).send(r.body);
  };
}
export function createNotificationHonoHandler(options: CallbackHandlerOptions) {
  return async (c: any): Promise<Response> => {
    for (const [key, value] of Object.entries(headers(c.req.header('origin'), options))) c.header(key, value);
    c.header('Allow', 'GET, HEAD, POST, OPTIONS');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    const body = c.req.method === 'POST' ? (c.req.header('content-type')?.includes('application/json') ? await c.req.json() : await c.req.parseBody()) : undefined;
    const r = await route(c.req.method, { token: c.req.query('token') }, body, options, c, c.req.header('origin'));
    if (c.req.method === 'HEAD') return c.body(null, r.status);
    return r.redirect ? c.redirect(r.redirect, 303) : r.html || options.responseFormat === 'html' ? c.html(r.html ?? renderApprovalConfirmation(r), r.status) : c.json(r.body, r.status);
  };
}
