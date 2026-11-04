import crypto from 'node:crypto';
import {
  WebhookProtocol,
  WebhookProtocolVerificationParams,
  ParsedWebhookHeaders
} from '../../types';
import { timingSafeCompare } from '../timing';
import { normalizeHeaders, isTimestampValid, payloadToString } from './base';

export class StripeWebhookProtocol implements WebhookProtocol {
  readonly name = 'stripe';

  parseHeaders(
    headers: Record<string, string | string[] | undefined> = {},
    signatureHeader: string = ''
  ): ParsedWebhookHeaders {
    const normalized = normalizeHeaders(headers);
    const rawHeader = signatureHeader || normalized['stripe-signature'] || '';

    let timestamp: number | undefined;
    const signatures: string[] = [];

    const elements = rawHeader.split(',');
    for (const element of elements) {
      const [key, value] = element.trim().split('=');
      if (key === 't') {
        const num = Number(value);
        if (!Number.isNaN(num)) {
          timestamp = num;
        }
      } else if (key === 'v1' && value) {
        signatures.push(value);
      }
    }

    return {
      timestamp,
      signatures,
      version: 'v1'
    };
  }

  formatSignedPayload(rawBody: string | Buffer, timestamp?: number): string {
    const bodyStr = payloadToString(rawBody);
    return timestamp !== undefined ? `${timestamp}.${bodyStr}` : bodyStr;
  }

  verify({
    secret,
    rawPayload,
    headers,
    signatureHeader,
    toleranceSeconds = 300,
    clock
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
    const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

    return parsed.signatures.some(sig => timingSafeCompare(expected, sig, 'hex'));
  }
}

export const stripeProtocol = new StripeWebhookProtocol();
