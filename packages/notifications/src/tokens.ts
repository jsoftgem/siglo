import { createHmac, randomUUID } from 'node:crypto';
import { timingSafeCompare, KeyRing } from '@siglo/crypto';
import { ValidationException } from '@siglo/core';
export interface ActionTokenPayload { stackId: string; correlationKey: string; expectedEvent: string; approved: boolean; expiresAt: number; issuedAt: number; nonce: string; kid?: string; inspection?: { stepId: string; stepName: string; attempt: number; namespace?: string } }
export function invalidToken(message = 'Invalid approval token'): never {
  throw new ValidationException([{ field: 'token', message }], { phase: 'validation', retryable: false });
}
export async function signActionToken(payload: Omit<ActionTokenPayload, 'nonce' | 'issuedAt' | 'kid'>, secret: string | KeyRing, now = Date.now()): Promise<string> {
  const active = typeof secret === 'string' ? { key: secret, kid: undefined } : await secret.getActiveKey();
  if (!active.key.length) invalidToken('Empty signing key');
  const body = Buffer.from(JSON.stringify({ ...payload, issuedAt: now, nonce: randomUUID(), kid: active.kid })).toString('base64url');
  return `${body}.${createHmac('sha256', active.key).update(body).digest('base64url')}`;
}
export async function verifyActionToken(token: string, secret: string | KeyRing, options: { now?: number; toleranceSeconds?: number } = {}): Promise<ActionTokenPayload> {
  try {
    if (token.length > 16384) invalidToken();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) invalidToken();
    const parts = token.split('.');
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as ActionTokenPayload;
    const key = typeof secret === 'string' ? secret : await secret.getKey(p.kid!);
    if (!key || !timingSafeCompare(createHmac('sha256', key).update(parts[0]).digest('base64url'), parts[1], 'base64url')) invalidToken();
    const now = options.now ?? Date.now();
    if (![p.stackId, p.correlationKey, p.expectedEvent, p.nonce].every(v => typeof v === 'string' && v.length > 0) || typeof p.approved !== 'boolean' || !Number.isFinite(p.expiresAt) || !Number.isFinite(p.issuedAt) || p.issuedAt > now + (options.toleranceSeconds ?? 0) * 1000) invalidToken();
    if (p.inspection && (typeof p.inspection.stepId !== 'string' || !p.inspection.stepId ||
      typeof p.inspection.stepName !== 'string' || !p.inspection.stepName ||
      !Number.isSafeInteger(p.inspection.attempt) || p.inspection.attempt < 1 ||
      (p.inspection.namespace !== undefined && typeof p.inspection.namespace !== 'string'))) invalidToken();
    if (p.expiresAt <= now) invalidToken('Approval token expired');
    return p;
  } catch (e) { if (e instanceof ValidationException) throw e; return invalidToken(); }
}
