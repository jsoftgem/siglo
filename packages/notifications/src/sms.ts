import { createHmac, randomBytes } from 'node:crypto';
import { timingSafeCompare } from '@siglo/crypto';
import { invalidToken } from './tokens';
export interface TwilioSmsReply {
    messageId: string;
    from: string;
    to: string;
    approved: boolean;
    reference: string;
}
/** Verify form-encoded Twilio webhooks using the exact configured public URL.
 * All original parameters must be supplied, including unknown future parameters.
 * The caller must bind reference + sender to its pending request and atomically claim
 * the wait before resumption. A signed SMS alone is not an approval authorization.
 */
export function parseTwilioSmsReply(
    params: Record<string, string>,
    options: { publicUrl: string; authToken: string; signature: string },
): TwilioSmsReply {
    if (!options.authToken || !options.publicUrl.startsWith('https://'))
        invalidToken('Invalid SMS webhook configuration');
    if (Object.values(params).some(value => typeof value !== 'string')) invalidToken('Invalid SMS form');
    const signed = Object.keys(params)
        .sort()
        .reduce((value, key) => value + key + params[key], options.publicUrl);
    const expected = createHmac('sha1', options.authToken).update(signed).digest('base64');
    if (!timingSafeCompare(expected, options.signature, 'base64')) invalidToken('Invalid SMS signature');
    if (
        !/^SM[a-zA-Z0-9]+$/.test(params.MessageSid ?? '') ||
        !/^\+[1-9]\d{6,14}$/.test(params.From ?? '') ||
        !/^\+[1-9]\d{6,14}$/.test(params.To ?? '')
    )
        invalidToken('Invalid SMS sender or message ID');
    const match = /^(approve|reject)\s+([a-zA-Z0-9:_-]{1,256})$/i.exec((params.Body ?? '').trim());
    if (!match) invalidToken('Reply must contain APPROVE or REJECT and a request reference');
    return {
        messageId: params.MessageSid,
        from: params.From,
        to: params.To,
        approved: match[1].toLowerCase() === 'approve',
        reference: match[2],
    };
}

/** Generate once and persist with the request, expected sender, destination and expiry. */
export function createSmsApprovalReference(prefix = 'approval'): string {
    if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(prefix)) throw new Error('Invalid SMS approval reference prefix');
    return `${prefix}:${randomBytes(16).toString('hex')}`;
}
export interface PendingSmsApproval {
    reference: string;
    from: string;
    to: string;
    expiresAt: number;
}
/** Validation only: the application must atomically consume its pending request before resuming. */
export function validateSmsApprovalReply(reply: TwilioSmsReply, pending: PendingSmsApproval, now = Date.now()): void {
    if (
        !Number.isFinite(pending.expiresAt) ||
        pending.expiresAt <= now ||
        !timingSafeCompare(reply.reference, pending.reference, 'utf8') ||
        reply.from !== pending.from ||
        reply.to !== pending.to
    ) {
        invalidToken('SMS reply does not match a pending approval');
    }
}
