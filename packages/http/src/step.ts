import { Step, observeEcosystem, recordInspection } from '@siglo/core';
import {
  HttpMethod,
  HttpStepOptions,
  HttpStepResult,
  CompensationHttpConfig,
  HttpStepInstance
} from './types';
import { extractHostInfo, assertNetworkPolicy, extractStaticHostname } from './policy/asl-bridge';
import { validatePayload } from './schema/validator';
import { executeHttpRequest } from './client/fetch';

export class HttpStep<TInput = any, TOutput = Record<string, any>, TName extends string = string>
  extends Step<TInput, HttpStepResult<TOutput>, TName>
  implements HttpStepInstance<TInput, TOutput, TName>
{
  private httpOptions: HttpStepOptions<TInput, TOutput>;

  constructor(name: TName, options: HttpStepOptions<TInput, TOutput>) {
    const action = async (ctx: TInput) => {
      // 1. Resolve parameters dynamically from context
      const resolvedUrl = typeof options.url === 'function' ? options.url(ctx) : options.url;
      const { hostname, port } = extractHostInfo(resolvedUrl);

      // Asserts hostname against active AsyncLocalStorage (ASL) network policy
      assertNetworkPolicy(name, resolvedUrl, hostname, port);

      const resolvedHeaders =
        typeof options.headers === 'function' ? options.headers(ctx) : (options.headers || {});
      const resolvedQuery =
        typeof options.query === 'function' ? options.query(ctx) : options.query;
      const resolvedBody =
        typeof options.body === 'function' ? options.body(ctx) : options.body;

      // 2. VALIDATION Phase: Validate outgoing request payload before touching the network
      if (options.requestSchema && resolvedBody !== undefined) {
        await validatePayload(options.requestSchema, resolvedBody, 'validation', name);
      }

      // 3. ACTION Phase: Network Execution via executeHttpRequest
      const res = await executeHttpRequest<TOutput>({
        capture: options.capture,
        stepName: name,
        url: resolvedUrl,
        method: options.method || 'GET',
        headers: resolvedHeaders,
        query: resolvedQuery,
        body: resolvedBody,
        responseType: options.responseType || 'json',
        retryOnStatus: options.retryOnStatus,
        maxRetries: options.maxRetries,
        allowNotFound: options.allowNotFound,
        timeoutMs: options.timeoutMs,
        signal: (ctx as any)?.$signal || (ctx as any)?.signal,
        span: (ctx as any)?.span || (ctx as any)?.$span,
        clock: options.clock,
        sleep: options.sleep
      });

      // Handle 404 when allowNotFound is true
      if (res.notFound) {
        const notFoundPayload: any = {
          notFound: true,
          data: null,
          $httpMetadata: res.metadata,
          httpMetadata: res.metadata
        };
        return notFoundPayload;
      }

      // 4. Validate incoming response payload if responseSchema is defined
      let validatedData = res.data;
      if (options.responseSchema) {
        validatedData = await validatePayload(options.responseSchema, res.data, 'action', name);
      }


      // 5. Attach $httpMetadata and construct return object
      if (
        typeof validatedData === 'object' &&
        validatedData !== null &&
        !Array.isArray(validatedData) &&
        typeof (validatedData as any).then !== 'function' &&
        !(typeof Blob !== 'undefined' && validatedData instanceof Blob) &&
        !(typeof ArrayBuffer !== 'undefined' && validatedData instanceof ArrayBuffer)
      ) {
        return {
          ...validatedData,
          data: validatedData,
          $httpMetadata: res.metadata,
          httpMetadata: res.metadata
        };
      }

      const wrappedResult: any = {
        data: validatedData,
        $httpMetadata: res.metadata,
        httpMetadata: res.metadata
      };

      return wrappedResult;
    };

    super(name, ((ctx: TInput) => observeEcosystem({ version: 1, kind: 'http', outcome: 'failure',
      method: options.method || 'GET', url: typeof options.url === 'string' ? options.url : undefined },
      () => action(ctx), result => ({ ...result.$httpMetadata, policy: 'allowed' as const }))) as any);
    this.httpOptions = options;

    // Static host assertion for graph inspection
    const staticHost = extractStaticHostname(options.url);
    if (staticHost) {
      this.allowNetwork([staticHost]);
    }

    // 1. BEFORE Phase: Validate ASL Network Egress Perimeter early
    this.onBefore(async (ctx: TInput) => {
      try {
      const resolvedUrl = typeof options.url === 'function' ? options.url(ctx) : options.url;
      const { hostname, port } = extractHostInfo(resolvedUrl);

      // Asserts hostname against active AsyncLocalStorage (ASL) network policy
      assertNetworkPolicy(name, resolvedUrl, hostname, port);

      } catch (error) {
        recordInspection({ version: 1, kind: 'http', outcome: 'failure', method: options.method || 'GET',
          url: typeof options.url === 'string' ? options.url : undefined,
          policy: (error as any)?.name === 'NetworkPolicyViolationException' ? 'denied' : 'unknown' });
        throw error;
      }
      return true;
    });

    // 4. AFTER Phase: Safely attach telemetry if context is extensible
    this.onAfter(async (output: any, ctx: any) => {
      try {
        if (output && output.$httpMetadata && ctx && typeof ctx === 'object') {
          if (!Object.isFrozen(ctx) && Object.isExtensible(ctx)) {
            if (!ctx.$steps) {
              ctx.$steps = {};
            }
            if (!ctx.$steps[name]) {
              ctx.$steps[name] = {};
            }
            ctx.$steps[name].httpMetadata = output.$httpMetadata;
          }
        }
      } catch {
        // Ignore if context is immutable or sealed
      }
      return output;
    });

    // 5. COMPENSATION Phase: Register declarative saga compensation if configured
    if (options.compensate) {
      this.compensateWithHttp(options.compensate);
    }
  }

  /**
   * Declarative saga rollback compensation via HTTP request.
   */
  compensateWithHttp(config: CompensationHttpConfig<TInput, TOutput>): this {
    this.compensate(async (res: any, ctx: any) => {
      const compUrl = typeof config.url === 'function' ? config.url(ctx, res) : config.url;
      const compMethod = config.method || 'DELETE';
      const compHeaders =
        typeof config.headers === 'function' ? config.headers(ctx, res) : (config.headers || {});
      const compQuery =
        typeof config.query === 'function' ? config.query(ctx, res) : config.query;
      const compBody =
        typeof config.body === 'function' ? config.body(ctx, res) : config.body;

      // Verify ASL network policy for compensation endpoint
      const { hostname, port } = extractHostInfo(compUrl);
      assertNetworkPolicy(`${this.name}:compensate`, compUrl, hostname, port);

      await executeHttpRequest({
        stepName: `${this.name}:compensate`,
        url: compUrl,
        method: compMethod as HttpMethod,
        headers: compHeaders,
        query: compQuery,
        body: compBody,
        clock: this.httpOptions.clock,
        sleep: this.httpOptions.sleep,
        retryOnStatus: this.httpOptions.retryOnStatus,
        maxRetries: this.httpOptions.maxRetries
      });
    });

    return this;
  }
}

/**
 * Creates a resilient, W3C-traced HTTP client step for Siglo workflows.
 */
export function httpStep<const TName extends string, TInput = any, TOutput = Record<string, any>>(
  name: TName,
  options: HttpStepOptions<TInput, TOutput>
): HttpStep<TInput, TOutput, TName> {
  return new HttpStep<TInput, TOutput, TName>(name, options);
}
