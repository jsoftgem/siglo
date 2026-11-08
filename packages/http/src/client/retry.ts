/**
 * Parses the HTTP `Retry-After` header value into milliseconds.
 *
 * Supports:
 * - Scenario A: Integer seconds (e.g. "120")
 * - Scenario B: RFC 1123 HTTP Date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
 *
 * @param headerValue The raw header string or null/undefined
 * @param now Optional timestamp provider (useful with FakeClock in tests)
 * @returns Delay in milliseconds, or undefined if absent/invalid
 */
export function parseRetryAfter(
    headerValue: string | null | undefined,
    now: () => number = () => Date.now(),
): number | undefined {
    if (!headerValue || typeof headerValue !== 'string') {
        return undefined;
    }

    const trimmed = headerValue.trim();
    if (!trimmed) {
        return undefined;
    }

    // Scenario A: Integer / decimal seconds (e.g. "120" or "1.5")
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) {
        return seconds >= 0 && Number.isFinite(seconds * 1000) ? Math.round(seconds * 1000) : undefined;
    }

    // Scenario B: RFC 1123 HTTP Date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
    const parsedDate = Date.parse(trimmed);
    if (!Number.isNaN(parsedDate)) {
        const delay = parsedDate - now();
        return Math.max(0, delay);
    }

    return undefined;
}

export const DEFAULT_RETRY_STATUSES: readonly number[] = [429, 502, 503, 504];

/**
 * Checks if a given status code is configured as retryable.
 */
export function isRetryableStatus(status: number, retryOnStatus: number[] = [...DEFAULT_RETRY_STATUSES]): boolean {
    return retryOnStatus.includes(status);
}

/**
 * Checks if an error is a transient transport/network error suitable for retry.
 */
export function isTransientNetworkError(error: any): boolean {
    if (!error) return false;
    const code = error.code || error.cause?.code;
    if (typeof code === 'string') {
        const transientCodes = [
            'ECONNRESET',
            'ETIMEDOUT',
            'EAI_AGAIN',
            'UND_ERR_CONNECT_TIMEOUT',
            'ENOTFOUND',
            'ECONNREFUSED',
        ];
        if (transientCodes.includes(code)) {
            return true;
        }
    }

    const message = (error.message || '').toLowerCase();
    if (
        message.includes('fetch failed') ||
        message.includes('network') ||
        message.includes('socket hung up') ||
        message.includes('econnreset') ||
        message.includes('etimedout')
    ) {
        return true;
    }

    return false;
}

/**
 * Calculates exponential backoff with full decorrelated jitter.
 *
 * @param attempt 0-indexed attempt count
 * @param baseDelayMs Base delay in milliseconds (defaults to 100ms)
 * @param maxDelayMs Maximum backoff cap (defaults to 10000ms)
 */
export function calculateBackoffDelay(attempt: number, baseDelayMs: number = 100, maxDelayMs: number = 10000): number {
    const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
    // Full jitter: random between 0 and exponential
    return Math.floor(Math.random() * (exponential + 1));
}
