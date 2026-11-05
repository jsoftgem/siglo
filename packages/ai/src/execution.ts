import { SigloError } from '@siglo/core';
import type { AiMetrics, AiStepResult } from './types';

export class AiRequestTimeoutError extends SigloError {
  constructor(readonly timeoutMs: number) {
    super(`AI provider request timed out after ${timeoutMs}ms`, { phase: 'action', retryable: true });
    Object.setPrototypeOf(this, AiRequestTimeoutError.prototype);
    this.name = 'AiRequestTimeoutError';
  }
}
export class AiProviderError extends SigloError {
  constructor(message: string, readonly status: number) {
    super(message, { phase: 'action', retryable: status === 429 || (status >= 500 && status <= 599) });
    Object.setPrototypeOf(this, AiProviderError.prototype);
    this.name = 'AiProviderError';
  }
}

/** Resolve Siglo's callable accessor as well as plain AbortSignal contexts. */
export function getExecutionSignal(ctx?: { $signal?: AbortSignal | (() => AbortSignal | undefined); signal?: AbortSignal } | null): AbortSignal | undefined {
  return (typeof ctx?.$signal === 'function' ? ctx.$signal() : ctx?.$signal) ?? ctx?.signal;
}

/** Only provider deadlines and explicit transient statuses qualify for fallback. */
export function shouldFallback(error: unknown, executionSignal?: AbortSignal): boolean {
  if (executionSignal?.aborted) return false;
  return error instanceof AiRequestTimeoutError ||
    (error instanceof AiProviderError && (error.status === 429 || (error.status >= 500 && error.status <= 599)));
}

/** Abort the transport and settle even when a faulty adapter ignores its signal. */
export async function withAiRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  executionSignal?: AbortSignal,
  timeoutMs?: number
): Promise<T> {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError('requestTimeoutMs must be a positive finite number');
  }
  executionSignal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (reason: unknown) => {
    controller.abort(reason);
    rejectAbort(reason);
  };
  const onAbort = () => abort(executionSignal!.reason);
  executionSignal?.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs !== undefined) timer = setTimeout(() => abort(new AiRequestTimeoutError(timeoutMs)), timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    executionSignal?.removeEventListener('abort', onAbort);
  }
}

export function createAiResult<T>(data: T, metrics: AiMetrics): AiStepResult<T> {
  return { data, $aiMetrics: metrics, aiMetrics: metrics };
}
