import crypto from 'node:crypto';
import { WebhookProtocol, WebhookProtocolVerificationParams, ParsedWebhookHeaders } from '../../types';
import { timingSafeCompare } from '../timing';
import { normalizeHeaders } from './base';

export class ShopifyWebhookProtocol implements WebhookProtocol {
    readonly name = 'shopify';

    parseHeaders(
        headers: Record<string, string | string[] | undefined> = {},
        signatureHeader: string = '',
    ): ParsedWebhookHeaders {
        const normalized = normalizeHeaders(headers);
        const signature = (signatureHeader || normalized['x-shopify-hmac-sha256'] || '').trim();

        return {
            signatures: signature ? [signature] : [],
            version: 'sha256',
        };
    }

    formatSignedPayload(rawBody: string | Buffer): string | Buffer {
        return rawBody;
    }

    verify({ secret, rawPayload, headers, signatureHeader }: WebhookProtocolVerificationParams): boolean {
        const parsed = this.parseHeaders(headers, signatureHeader);

        if (parsed.signatures.length === 0) {
            return false;
        }

        const payload = this.formatSignedPayload(rawPayload);
        const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');

        return parsed.signatures.some(sig => timingSafeCompare(expected, sig, 'base64'));
    }
}

export const shopifyProtocol = new ShopifyWebhookProtocol();
