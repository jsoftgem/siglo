import { Step } from 'siglo';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

type NoInferType<T> = [T][T extends any ? 0 : never];

export interface HttpMetadata {
  status: number;
  statusText: string;
  durationMs: number;
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  traceId?: string;
  retryAttempts: number;
  cUrl?: string;
}

export interface CompensationHttpConfig<TInput = any, TOutput = Record<string, any>> {
  url: string | ((ctx: TInput, res: TOutput) => string);
  method?: 'DELETE' | 'POST' | 'PUT';
  headers?: Record<string, string> | ((ctx: TInput, res: TOutput) => Record<string, string>);
  query?: Record<string, string | number | boolean | undefined> | ((ctx: TInput, res: TOutput) => Record<string, string | number | boolean | undefined>);
  body?: ((ctx: TInput, res: TOutput) => any) | Record<string, any> | any[] | string | number | boolean | null;
}

export interface HttpStepOptions<TInput = any, TOutput = Record<string, any>, TRequestSchema = unknown, TResponseSchema = unknown> {
  url: string | ((ctx: TInput) => string);
  method?: HttpMethod;
  headers?: Record<string, string> | ((ctx: TInput) => Record<string, string>);
  query?: Record<string, string | number | boolean | undefined> | ((ctx: TInput) => Record<string, string | number | boolean | undefined>);
  body?: ((ctx: TInput) => any) | Record<string, any> | any[] | string | number | boolean | null;

  /** Schema for validating outgoing request payload */
  requestSchema?: TRequestSchema;

  /** Schema for validating and typing incoming response payload */
  responseSchema?: TResponseSchema;

  /** Parser type: 'json' (default), 'text', 'blob', 'arrayBuffer' */
  responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer';

  /** Custom status codes to trigger retry (defaults to [429, 502, 503, 504]) */
  retryOnStatus?: number[];

  /** Maximum number of retry attempts (defaults to 3) */
  maxRetries?: number;

  /** If true, 404 does not throw but returns { notFound: true, data: null } */
  allowNotFound?: boolean;

  /** Request timeout in milliseconds (overrides step-level timeout) */
  timeoutMs?: number;

  /** Declarative saga compensation */
  compensate?: CompensationHttpConfig<TInput, NoInferType<TOutput>>;

  /** Optional clock hook for testing */
  clock?: { now(): number };

  /** Optional sleep hook for testing */
  sleep?: (ms: number) => Promise<void>;
}

export type HttpStepResult<TOutput = Record<string, any>> = TOutput & { $httpMetadata: HttpMetadata };

export interface HttpStepInstance<TInput = any, TOutput = Record<string, any>, TName extends string = string>
  extends Step<TInput, HttpStepResult<TOutput>, TName> {
  compensateWithHttp(config: CompensationHttpConfig<TInput, TOutput>): this;
}
