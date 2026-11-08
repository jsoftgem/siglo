import crypto from 'node:crypto';
import { WebhookProtocol, WebhookProtocolVerificationParams, ParsedWebhookHeaders } from '../../types';
import { timingSafeCompare } from '../timing';
import { normalizeHeaders, isTimestampValid, payloadToString } from './base';

export class SlackWebhookProtocol implements WebhookProtocol {
    readonly name = 'slack';

    parseHeaders(
        headers: Record<string, string | string[] | undefined> = {},
        signatureHeader: string = '',
    ): ParsedWebhookHeaders {
        const normalized = normalizeHeaders(headers);
        const rawSignature = (signatureHeader || normalized['x-slack-signature'] || '').trim();

        const rawTimestamp = normalized['x-slack-request-timestamp'];
        const timestamp = rawTimestamp ? Number(rawTimestamp) : undefined;

        return {
            timestamp: !Number.isNaN(timestamp) ? timestamp : undefined,
            signatures: rawSignature ? [rawSignature] : [],
            version: 'v0',
        };
    }

    formatSignedPayload(rawBody: string | Buffer, timestamp?: number): string {
        const bodyStr = payloadToString(rawBody);
        return `v0:${timestamp !== undefined ? timestamp : ''}:${bodyStr}`;
    }

    verify({
        secret,
        rawPayload,
        headers,
        signatureHeader,
        toleranceSeconds = 300,
        clock,
    }: WebhookProtocolVerificationParams): boolean {
        const parsed = this.parseHeaders(headers, signatureHeader);

        if (parsed.timestamp === undefined || parsed.signatures.length === 0) {
            return false;
        }

        const nowSec = clock ? Math.floor(clock.now() / 1000) : Math.floor(Date.now() / 1000);
        if (!isTimestampValid(parsed.timestamp, toleranceSeconds, nowSec)) {
            return false;
        }

        const signedPayload = this.formatSignedPayload(rawPayload, parsed.timestamp);
        const hmacHex = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
        const expected = `v0=${hmacHex}`;

        return parsed.signatures.some(sig => {
            // Compare both with v0= prefix or without
            if (sig.startsWith('v0=')) {
                return timingSafeCompare(expected, sig, 'utf8');
            }
            return timingSafeCompare(hmacHex, sig, 'hex');
        });
    }
}

export const slackProtocol = new SlackWebhookProtocol();
