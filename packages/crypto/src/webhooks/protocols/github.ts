import crypto from 'node:crypto';
import {
  WebhookProtocol,
  WebhookProtocolVerificationParams,
  ParsedWebhookHeaders
} from '../../types';
import { timingSafeCompare } from '../timing';
import { normalizeHeaders } from './base';

export class GitHubWebhookProtocol implements WebhookProtocol {
  readonly name = 'github';

  parseHeaders(
    headers: Record<string, string | string[] | undefined> = {},
    signatureHeader: string = ''
  ): ParsedWebhookHeaders {
    const normalized = normalizeHeaders(headers);
    const rawHeader = signatureHeader ||
      normalized['x-hub-signature-256'] ||
      normalized['x-hub-signature'] ||
      '';

    let version = 'sha256';
    let signature = rawHeader.trim();

    if (signature.startsWith('sha256=')) {
      version = 'sha256';
      signature = signature.slice(7);
    } else if (signature.startsWith('sha1=')) {
      version = 'sha1';
      signature = signature.slice(5);
    }

    return {
      signatures: signature ? [signature] : [],
      version
    };
  }

  formatSignedPayload(rawBody: string | Buffer): string | Buffer {
    return rawBody;
  }

  verify({
    secret,
    rawPayload,
    headers,
    signatureHeader
  }: WebhookProtocolVerificationParams): boolean {
    const parsed = this.parseHeaders(headers, signatureHeader);

    if (parsed.signatures.length === 0) {
      return false;
    }

    const algorithm = parsed.version === 'sha1' ? 'sha1' : 'sha256';
    const payload = this.formatSignedPayload(rawPayload);
    const expected = crypto.createHmac(algorithm, secret).update(payload).digest('hex');

    return parsed.signatures.some(sig => timingSafeCompare(expected, sig, 'hex'));
  }
}

export const gitHubProtocol = new GitHubWebhookProtocol();
