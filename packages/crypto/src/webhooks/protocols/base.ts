import {
  WebhookProtocol,
  WebhookProtocolVerificationParams,
  ParsedWebhookHeaders
} from '../../types';

export {
  WebhookProtocol,
  WebhookProtocolVerificationParams,
  ParsedWebhookHeaders
};

/**
 * Normalizes headers record by converting all keys to lowercase.
 */
export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined> = {}
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val !== undefined && val !== null) {
      normalized[key.toLowerCase()] = Array.isArray(val) ? val.join(',') : String(val);
    }
  }
  return normalized;
}

/**
 * Asserts whether a timestamp is within the allowed clock drift tolerance.
 */
export function isTimestampValid(
  timestamp: number | undefined,
  toleranceSeconds: number = 300,
  nowSeconds?: number
): boolean {
  if (timestamp === undefined || Number.isNaN(timestamp) || toleranceSeconds <= 0) {
    return true;
  }

  // Normalize millisecond timestamp to seconds if needed
  let ts = timestamp;
  if (ts > 1e11) {
    ts = Math.floor(ts / 1000);
  }

  const now = nowSeconds !== undefined ? nowSeconds : Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= toleranceSeconds;
}

/**
 * Extracts payload as UTF-8 string.
 */
export function payloadToString(payload: string | Buffer): string {
  if (typeof payload === 'string') {
    return payload;
  }
  return payload.toString('utf8');
}
