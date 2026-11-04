import crypto from 'node:crypto';
import {
  WebhookProtocol,
  WebhookProtocolVerificationParams,
  ParsedWebhookHeaders
} from '../../types';
import { timingSafeCompare } from '../timing';
import { normalizeHeaders, isTimestampValid, payloadToString } from './base';

export interface GenericHmacProtocolOptions {
  algorithm?: 'sha256' | 'sha512' | 'sha1';
  encoding?: 'hex' | 'base64';
}

export class GenericHmacWebhookProtocol implements WebhookProtocol {
  readonly name = 'generic-hmac';
  private defaultAlgorithm: 'sha256' | 'sha512' | 'sha1';
  private defaultEncoding?: 'hex' | 'base64';

  constructor(options: GenericHmacProtocolOptions = {}) {
    this.defaultAlgorithm = options.algorithm || 'sha256';
    this.defaultEncoding = options.encoding;
  }

  parseHeaders(
    headers: Record<string, string | string[] | undefined> = {},
    signatureHeader: string = ''
  ): ParsedWebhookHeaders {
    const normalized = normalizeHeaders(headers);
    const signature = (
      signatureHeader ||
      normalized['x-signature'] ||
      normalized['signature'] ||
      normalized['x-hub-signature-256'] ||
      ''
    ).trim();

    const rawTimestamp = normalized['x-timestamp'] || normalized['timestamp'];
    const timestamp = rawTimestamp ? Number(rawTimestamp) : undefined;

    return {
      timestamp: !Number.isNaN(timestamp) ? timestamp : undefined,
      signatures: signature ? [signature] : []
    };
  }

  formatSignedPayload(rawBody: string | Buffer, timestamp?: number): string | Buffer {
    if (timestamp !== undefined) {
      return `${timestamp}.${payloadToString(rawBody)}`;
    }
    return rawBody;
  }

  verify({
    secret,
    rawPayload,
    headers,
    signatureHeader,
    toleranceSeconds = 300,
    clock,
    algorithm: paramAlgorithm
  }: WebhookProtocolVerificationParams): boolean {
    const parsed = this.parseHeaders(headers, signatureHeader);

    if (parsed.signatures.length === 0) {
      return false;
    }

    if (parsed.timestamp !== undefined) {
      const nowSec = clock ? Math.floor(clock.now() / 1000) : Math.floor(Date.now() / 1000);
      if (!isTimestampValid(parsed.timestamp, toleranceSeconds, nowSec)) {
        return false;
      }
    }

    const algorithm = paramAlgorithm || (headers as any)?.$algorithm || this.defaultAlgorithm;
    const signedPayload = this.formatSignedPayload(rawPayload, parsed.timestamp);

    const expectedHex = crypto.createHmac(algorithm, secret).update(signedPayload).digest('hex');
    const expectedBase64 = crypto.createHmac(algorithm, secret).update(signedPayload).digest('base64');

    return parsed.signatures.some(sig => {
      if (this.defaultEncoding === 'base64') {
        return timingSafeCompare(expectedBase64, sig, 'base64');
      }
      if (this.defaultEncoding === 'hex') {
        return timingSafeCompare(expectedHex, sig, 'hex');
      }
      // Auto-detect hex vs base64
      return (
        timingSafeCompare(expectedHex, sig, 'hex') ||
        timingSafeCompare(expectedBase64, sig, 'base64')
      );
    });
  }
}

export const genericHmacProtocol = new GenericHmacWebhookProtocol();
