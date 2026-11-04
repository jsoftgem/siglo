import crypto from 'node:crypto';
import {
  WebhookProtocol,
  WebhookProtocolVerificationParams,
  ParsedWebhookHeaders
} from '../../types';
import { timingSafeCompare } from '../timing';
import { normalizeHeaders, isTimestampValid, payloadToString } from './base';

export class SvixWebhookProtocol implements WebhookProtocol {
  readonly name = 'svix';

  parseHeaders(
    headers: Record<string, string | string[] | undefined> = {},
    signatureHeader: string = ''
  ): ParsedWebhookHeaders {
    const normalized = normalizeHeaders(headers);
    const rawHeader = signatureHeader ||
      normalized['svix-signature'] ||
      normalized['webhook-signature'] ||
      '';

    const rawTimestamp = normalized['svix-timestamp'] || normalized['webhook-timestamp'];
    const timestamp = rawTimestamp ? Number(rawTimestamp) : undefined;

    const signatures: string[] = [];
    const parts = rawHeader.trim().split(/\s+/);
    for (const part of parts) {
      if (part.startsWith('v1,')) {
        signatures.push(part.slice(3));
      } else if (part.startsWith('v1=')) {
        signatures.push(part.slice(3));
      } else if (part) {
        signatures.push(part);
      }
    }

    return {
      timestamp: !Number.isNaN(timestamp) ? timestamp : undefined,
      signatures,
      version: 'v1'
    };
  }

  formatSignedPayload(rawBody: string | Buffer, timestamp?: number, svixId?: string): string {
    const bodyStr = payloadToString(rawBody);
    return `${svixId || ''}.${timestamp !== undefined ? timestamp : ''}.${bodyStr}`;
  }

  verify({
    secret,
    rawPayload,
    headers,
    signatureHeader,
    toleranceSeconds = 300,
    clock
  }: WebhookProtocolVerificationParams): boolean {
    const normalized = normalizeHeaders(headers);
    const parsed = this.parseHeaders(headers, signatureHeader);

    if (parsed.timestamp === undefined || parsed.signatures.length === 0) {
      return false;
    }

    const nowSec = clock ? Math.floor(clock.now() / 1000) : Math.floor(Date.now() / 1000);
    if (!isTimestampValid(parsed.timestamp, toleranceSeconds, nowSec)) {
      return false;
    }

    const svixId = normalized['svix-id'] || normalized['webhook-id'] || '';
    const toSign = `${svixId}.${parsed.timestamp}.${payloadToString(rawPayload)}`;

    // Asymmetric Public Key (Ed25519 or RSA) check
    const secretStr = typeof secret === 'string' ? secret : '';
    if (secretStr.includes('-----BEGIN PUBLIC KEY-----')) {
      try {
        const toSignBuf = Buffer.from(toSign, 'utf8');
        return parsed.signatures.some(sig => {
          try {
            const sigBuf = Buffer.from(sig, 'base64');
            return crypto.verify(null, toSignBuf, secret, sigBuf);
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    }

    // Symmetric HMAC verification
    let secretKey: string | Buffer = secret;
    if (typeof secret === 'string' && secret.startsWith('whsec_')) {
      secretKey = Buffer.from(secret.slice(6), 'base64');
    }

    const expected = crypto.createHmac('sha256', secretKey).update(toSign).digest('base64');
    return parsed.signatures.some(sig => timingSafeCompare(expected, sig, 'base64'));
  }
}

export const svixProtocol = new SvixWebhookProtocol();
