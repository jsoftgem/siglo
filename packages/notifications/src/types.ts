import type { Step, Flow, IdempotencyStore } from '@siglo/core';
import type { KeyRing } from '@siglo/crypto';
import type { StandardSchemaV1 } from '@siglo/http';
export type NotificationChannel = 'email' | 'slack' | 'discord' | 'sms' | 'push';
export interface NotificationRecipient { email?: string; phone?: string; slackUserId?: string; slackChannelId?: string; pushToken?: string; discordWebhookUrl?: string }
export interface NotificationMetadata { notificationId: string; channel: NotificationChannel; dispatchedAt: number; recipientMasked: string; approvalExpiresAt?: number; stackId?: string }
export interface ResolvedNotificationMessage {
  to: string | NotificationRecipient; subject?: string; content: string;
  interactiveActions?: { approveUrl: string; rejectUrl: string; title: string; description?: string };
  idempotencyKey?: string;
  metadata?: Record<string, unknown>; signal?: AbortSignal;
}
export interface NotificationTransport {
  readonly channel: NotificationChannel; readonly allowedHosts: string[];
  send(message: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }>;
  cancel?(notificationId: string, reason: string): Promise<void>;
}
export type Dynamic<T, C> = T | ((ctx: C) => T);
export interface SendNotificationOptions<TInput> {
  capture?: import('@siglo/core').InspectionCapturePolicy;
  channel: Dynamic<NotificationChannel, TInput>; recipient: Dynamic<string | NotificationRecipient, TInput>;
  subject?: Dynamic<string, TInput>; template: Dynamic<string, TInput>; dataSchema?: StandardSchemaV1;
  data?: (ctx: TInput) => Record<string, unknown>; deduplicationTtl?: number; compensateOnFailure?: boolean;
  dispatchStore?: import('./dispatch').NotificationDispatchStore;
  transport?: NotificationTransport; idempotencyStore?: IdempotencyStore;
}
export interface InteractiveApprovalOptions<TInput> {
  capture?: import('@siglo/core').InspectionCapturePolicy;
  channel: 'email' | 'slack'; recipient: Dynamic<string | NotificationRecipient, TInput>;
  title: Dynamic<string, TInput>; description?: Dynamic<string, TInput>; correlationKey: Dynamic<string, TInput>;
  timeout: string; onApproveEvent: string; onRejectEvent: string; callbackBaseUrl: string;
  dispatchStore?: import('./dispatch').NotificationDispatchStore;
  signingSecret: string | KeyRing; autoCompensate?: boolean; transport?: NotificationTransport; idempotencyStore?: IdempotencyStore;
}
export interface CallbackHandlerOptions {
  /** Receives correlated callback inspections for tokens issued by monitored steps. */
  monitor?: import('@siglo/core').WorkflowEventEmitter;
  /** Explicit opt-in to link-possession authorization. Prefer authorize for sensitive actions. */
  allowBearerApproval?: boolean;
  /** Bind the signed request to an authenticated approver. Throw or return false to deny. */
  authorize?: (payload: import('./tokens').ActionTokenPayload, request?: any) => boolean | Promise<boolean>;
  responseFormat?: 'json' | 'html';
  allowedOrigins?: string[];
  signingSecret: string | KeyRing; workflow: Flow<any, any>; onSuccessRedirect?: string;
  onExpiredRedirect?: string; onErrorRedirect?: string; toleranceSeconds?: number;
}
export type NotificationResult = { notificationId: string; sentAt: number; $notificationMetadata: NotificationMetadata; notificationMetadata?: NotificationMetadata };
export type ApprovalResult = NotificationResult & { correlationKey: string; approvalTokens: { approveUrl: string; rejectUrl: string } };
export type NotificationStep<I, N extends string> = Step<I, NotificationResult, N>;
