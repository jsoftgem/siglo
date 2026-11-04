import { getNotificationDispatchStore } from './dispatch';
import { createHash } from 'node:crypto';
import { Step, observeEcosystem, captureInspection, EcosystemInspection, recordInspection, stepInspectionStorage, parseDuration, registerCompensationHandler, hasCompensationHandler, emitMonitoringEvent, redactEvent, defaultStorageManager, ValidationException } from 'siglo';
import { assertNetworkPolicy, validatePayload } from '@siglo/http';
import { getNotificationTransport } from './registry';
import { getApprovalRevocationStore } from './approvals';
import { signActionToken } from './tokens';
import { SendNotificationOptions, InteractiveApprovalOptions, NotificationResult, NotificationMetadata, ApprovalResult, NotificationTransport, ResolvedNotificationMessage } from './types';
const resolve = <T>(v: T | ((ctx: any) => T), ctx: any): T => typeof v === 'function' ? (v as (ctx: any) => T)(ctx) : v;
export function assertTransportPolicy(name: string, transport: NotificationTransport): void {
  for (const host of transport.allowedHosts) assertNetworkPolicy(name, `https://${host}`, host);
}
async function cancelNotification(output: NotificationResult & { correlationKey?: string }, transport: NotificationTransport): Promise<void> {
  if (output.correlationKey) await getApprovalRevocationStore().revoke(output.correlationKey);
  if (!transport.cancel && output.correlationKey) return;
  assertTransportPolicy('cancelNotification', transport);
  if (!transport.cancel) throw new Error('Transport does not support cancellation');
  await transport.cancel(output.notificationId, 'Workflow cancelled');
}

export function registerNotificationCompensationHandlers(): void {
  if (hasCompensationHandler('cancelNotification')) return;
  registerCompensationHandler('cancelNotification', output =>
    cancelNotification(output, getNotificationTransport(output.$notificationMetadata.channel)));
}
registerNotificationCompensationHandlers();

export function sendNotificationStep<const N extends string, I = any>(name: N, options: SendNotificationOptions<I>): Step<I, NotificationResult, N> {
  return createNotificationStep(name, options);
}

function createNotificationStep<const N extends string, I>(
  name: N,
  options: SendNotificationOptions<I>,
  enrich?: (ctx: I) => Promise<{ actions: ResolvedNotificationMessage['interactiveActions']; extra: Record<string, unknown> }>
): Step<I, NotificationResult, N> {
  registerNotificationCompensationHandlers();
  const transportFor = (ctx: I) => options.transport ?? getNotificationTransport(resolve(options.channel, ctx));
  // Schema and before hooks run outside the observed action. Report their failures
  // without resolving caller callbacks again or copying exception content.
  const inspectPreAction = async <T>(action: () => T | Promise<T>): Promise<T> => {
    const started = Date.now();
    try { return await action(); }
    catch (error) {
      recordInspection({ version: 1, kind: 'notification', outcome: 'failure',
        approval: !!enrich, tokenStatus: 'unavailable', durationMs: Date.now() - started,
        channel: typeof options.channel === 'string' ? options.channel : undefined });
      throw error;
    }
  };
  const dispatchKey = (ctx: any) => `${typeof ctx?.$stackId === 'function' ? ctx.$stackId() : ctx?.$stackId || ctx?.stackId || 'standalone'}:${name}:${createHash('sha256').update(JSON.stringify(resolve(options.recipient, ctx))).digest('hex')}`;
  const action = async (ctx: I, inspection: EcosystemInspection) => {
    const channel = resolve(options.channel, ctx), to = resolve(options.recipient, ctx), transport = transportFor(ctx);
    if (transport.channel !== channel) throw new Error('Notification transport channel mismatch');
    assertTransportPolicy(name, transport);
    const target = typeof to === 'string' ? to : channel === 'email' ? to.email : channel === 'sms' ? to.phone : channel === 'slack' ? to.slackChannelId || to.slackUserId : channel === 'push' ? to.pushToken : to.discordWebhookUrl;
    const idempotencyKey = createHash('sha256').update(dispatchKey(ctx)).digest('hex');
    const intent = await (options.dispatchStore ?? getNotificationDispatchStore()).prepare(idempotencyKey, async () => {
      const enriched = await enrich?.(ctx);
      return { message: { to, idempotencyKey, subject: options.subject === undefined ? undefined : resolve(options.subject, ctx), content: resolve(options.template, ctx), interactiveActions: enriched?.actions }, extra: enriched?.extra };
    });
    inspection.content = captureInspection(options.capture, 'preview', intent.message.content);
    const result = await transport.send({ ...intent.message, signal: typeof (ctx as any)?.$signal === 'function' ? (ctx as any).$signal() : (ctx as any)?.$signal });
    const metadata: NotificationMetadata = { notificationId: result.id, channel, dispatchedAt: result.timestamp, recipientMasked: `${target!.slice(0, 1)}***` };
    const stackId = typeof (ctx as any)?.$stackId === 'function' ? (ctx as any).$stackId() : (ctx as any)?.$stackId || (ctx as any)?.stackId || 'standalone';
    metadata.stackId = stackId;
    if (enrich && typeof intent.extra?.approvalExpiresAt === 'number') {
      metadata.approvalExpiresAt = intent.extra.approvalExpiresAt;
    }
    return { ...intent.extra, notificationId: result.id, sentAt: result.timestamp, $notificationMetadata: metadata, notificationMetadata: metadata };
  };
  const step = new Step<I, NotificationResult, N>(name, ctx => { const inspection: EcosystemInspection = {
    version: 1, kind: 'notification', outcome: 'failure', approval: !!enrich,
    channel: typeof options.channel === 'string' ? options.channel : undefined
  }; return observeEcosystem(inspection, () => action(ctx, inspection), result => ({ channel: result.$notificationMetadata.channel,
    notificationId: result.notificationId, approvalState: enrich ? 'requested' as const : undefined, approvalExpiresAt: result.$notificationMetadata.approvalExpiresAt, tokenStatus: enrich ? 'issued' as const : 'unavailable' as const })); });
  step.schema({ '~standard': { version: 1, vendor: 'siglo-notifications', validate: async (ctx: I) => inspectPreAction(async () => {
    const channel = resolve(options.channel, ctx), to = resolve(options.recipient, ctx);
    const target = typeof to === 'string' ? to : channel === 'email' ? to.email : channel === 'sms' ? to.phone : channel === 'slack' ? to.slackChannelId || to.slackUserId : channel === 'push' ? to.pushToken : to.discordWebhookUrl;
    const valid = target && (channel === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target) : channel === 'sms' ? /^\+[1-9]\d{6,14}$/.test(target) : channel === 'slack' ? /^[A-Z][A-Z0-9]+$/.test(target) : channel === 'push' ? target.length > 0 : /^https:\/\/discord.com\/api\/webhooks\//.test(target));
    if (!valid) throw new ValidationException([{ field: 'recipient', message: 'Invalid notification recipient' }], { phase: 'validation', retryable: false });
    if (options.dataSchema) await validatePayload(options.dataSchema, options.data?.(ctx) ?? ctx, 'validation', name);
    return { value: ctx };
  }) } });
  step.onAfter(async output => {
    const metadata = output.$notificationMetadata;
    const stackId = metadata.stackId!;
    for (const type of (enrich ? ['notification:dispatched', 'approval:requested'] : ['notification:dispatched']) as ('notification:dispatched' | 'approval:requested')[]) {
      emitMonitoringEvent({ monitor: defaultStorageManager.getStack(stackId)?.monitor }, redactEvent({ type, stackId, stepId: name, timestamp: output.sentAt, ...metadata }));
    }
    return output;
  });
  step.onBefore(async ctx => inspectPreAction(() => { assertTransportPolicy(name, transportFor(ctx)); return true; }));

  if (options.transport) step.allowNetwork(options.transport.allowedHosts);
  step.idempotent(dispatchKey, { ttlMs: (options.deduplicationTtl ?? 86400) * 1000, store: options.idempotencyStore });
  if (options.compensateOnFailure) {
    if (options.transport) step.compensate((out: NotificationResult & { correlationKey?: string }) => cancelNotification(out, options.transport!));
    else step.compensate('cancelNotification');
  }
  return step;
}
export function sendInteractiveApprovalStep<const N extends string, I = any>(name: N, options: InteractiveApprovalOptions<I>): Step<I, ApprovalResult, N> {
  const ttl = parseDuration(options.timeout);
  if (!ttl || !Number.isFinite(ttl) || ttl <= 0) throw new Error('Approval timeout must be positive');
  return createNotificationStep(name, { capture: options.capture, channel: options.channel, recipient: options.recipient, template: options.title, transport: options.transport, idempotencyStore: options.idempotencyStore, dispatchStore: options.dispatchStore, compensateOnFailure: options.autoCompensate }, async ctx => {
    const correlationKey = resolve(options.correlationKey, ctx);
    const stackId = typeof (ctx as any)?.$stackId === 'function' ? (ctx as any).$stackId() : (ctx as any)?.$stackId || (ctx as any)?.stackId || correlationKey;
    const expiresAt = Date.now() + ttl;
    const scope = stepInspectionStorage.getStore();
    const inspection = scope ? { stepId: scope.stepId, stepName: scope.stepName, attempt: scope.attempt, namespace: scope.namespace } : undefined;
    const url = async (approved: boolean) => { const u = new URL(options.callbackBaseUrl); if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error('Callback URL must use HTTPS'); u.searchParams.set('token', await signActionToken({ stackId, correlationKey, expectedEvent: approved ? options.onApproveEvent : options.onRejectEvent, approved, expiresAt, inspection }, options.signingSecret)); return u.toString(); };
    const approvalTokens = { approveUrl: await url(true), rejectUrl: await url(false) };
    return { actions: { ...approvalTokens, title: resolve(options.title, ctx), description: options.description === undefined ? undefined : resolve(options.description, ctx) }, extra: { correlationKey, approvalTokens, approvalExpiresAt: expiresAt } };
  }) as unknown as Step<I, ApprovalResult, N>;
}
