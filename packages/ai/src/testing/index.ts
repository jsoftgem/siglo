import type { AiProviderAdapter, AiProviderRequest, AiProviderResponse } from '../types';

type Outcome = AiProviderResponse | Error;
export interface AiReplayRecord {
  request: Omit<AiProviderRequest, 'signal'>;
  outcome: AiProviderResponse | { error: string; status?: number; timeoutMs?: number };
}
import { AiProviderError, AiRequestTimeoutError } from '../execution';

/** Scripted, isolated, fail-closed provider. It never touches fetch or global state. */
export class MockAiProvider implements AiProviderAdapter {
  readonly requests: Omit<AiProviderRequest, 'signal'>[] = [];
  private readonly outcomes: Outcome[];
  private readonly recorded: AiReplayRecord[] = [];
  constructor(outcomes: readonly Outcome[] = []) { this.outcomes = [...outcomes]; }

  async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
    request.signal.throwIfAborted();
    const { signal: _signal, ...input } = request;
    const captured = structuredClone(input);
    this.requests.push(captured);
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error('MockAiProvider response queue exhausted');
    this.recorded.push({ request: structuredClone(captured), outcome: outcome instanceof Error
      ? { error: outcome.message,
        status: outcome instanceof AiProviderError ? outcome.status : undefined,
        timeoutMs: outcome instanceof AiRequestTimeoutError ? outcome.timeoutMs : undefined }
      : structuredClone(outcome) });
    if (outcome instanceof Error) throw outcome;
    return structuredClone(outcome);
  }
  assertDone(): void {
    if (this.outcomes.length) throw new Error(`MockAiProvider has ${this.outcomes.length} unused responses`);
  }
  exportRecording(): AiReplayRecord[] { return structuredClone(this.recorded); }
  static replay(records: readonly AiReplayRecord[]): AiProviderAdapter {
    const script = new MockAiProvider(records.map(r => 'error' in r.outcome
      ? r.outcome.status !== undefined ? new AiProviderError(r.outcome.error, r.outcome.status)
        : r.outcome.timeoutMs !== undefined ? new AiRequestTimeoutError(r.outcome.timeoutMs) : new Error(r.outcome.error)
      : r.outcome));
    let cursor = 0;
    return { async generate(request) {
      const { signal: _signal, ...actual } = request;
      const expected = records[cursor++];
      if (!expected || JSON.stringify(actual) !== JSON.stringify(expected.request)) {
        throw new Error('MockAiProvider replay request mismatch');
      }
      return script.generate(request);
    } };
  }
}
