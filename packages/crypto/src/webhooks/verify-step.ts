import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Step, ValidationException, ExecutionOptions } from 'siglo';
import {
  WebhookVerifyOptions,
  WebhookVerificationResult,
  WebhookProtocol,
  WebhookPayloadRef
} from '../types';
import { getWebhookProtocol } from '../registry';
import { normalizeHeaders } from './protocols/base';
import { createDedupKey } from './dedup';

function sanitizeStepInput<T>(param: T): T {
  if (!param || typeof param !== 'object' || Array.isArray(param)) {
    return param;
  }
  const clean: Record<string, any> = {};
  for (const [key, val] of Object.entries(param)) {
    if (key !== '$steps' && key !== '$history' && key !== '$stackId') {
      clean[key] = val;
    }
  }
  return clean as T;
}

/**
 * Checks if a value is a readable stream or async iterable of chunks.
 */
export function isStreamPayload(val: unknown): val is NodeJS.ReadableStream | AsyncIterable<Buffer> {
  return (
    typeof val === 'object' &&
    val !== null &&
    (typeof (val as any)[Symbol.asyncIterator] === 'function' || typeof (val as any).pipe === 'function')
  );
}

/**
 * Validates whether a value is a raw string, Buffer, Uint8Array, serialized Buffer object, or stream.
 */
export function isRawPayload(val: unknown): val is string | Buffer | NodeJS.ReadableStream | AsyncIterable<Buffer> {
  if (typeof val === 'string' || Buffer.isBuffer(val) || val instanceof Uint8Array || isStreamPayload(val)) {
    return true;
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const keys = Object.keys(val);
    if (keys.length > 0 && keys.every((k, i) => k === String(i) && typeof (val as any)[k] === 'number')) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes synchronous raw payload into string or Buffer.
 */
export function normalizeRawPayload(val: unknown): string | Buffer {
  if (typeof val === 'string' || Buffer.isBuffer(val)) {
    return val;
  }
  if (val instanceof Uint8Array) {
    return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const keys = Object.keys(val);
    if (keys.length > 0 && keys.every((k, i) => k === String(i) && typeof (val as any)[k] === 'number')) {
      return Buffer.from(Object.values(val) as number[]);
    }
  }
  return String(val ?? '');
}

/**
 * Resolves raw payload and handles optional stream reading, size limits, and disk spooling.
 */
async function resolvePayloadData(
  val: unknown,
  options: WebhookVerifyOptions<any>,
  stepName: string
): Promise<{ rawPayload: string | Buffer; payloadRef: WebhookPayloadRef }> {
  const maxBytes = options.maxBodyBytes ?? 10 * 1024 * 1024; // 10MB default
  const spoolThreshold = options.spoolThresholdBytes ?? 5 * 1024 * 1024; // 5MB default

  if (isStreamPayload(val)) {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let fileStream: fs.WriteStream | undefined;
    let filePath: string | undefined;

    for await (const chunk of val as any) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;

      if (maxBytes > 0 && totalBytes > maxBytes) {
        if (fileStream) {
          fileStream.close();
          try {
            fs.unlinkSync(filePath!);
          } catch {}
        }
        throw new ValidationException(
          [{ field: 'payload', message: `Payload exceeds maximum allowed size of ${maxBytes} bytes` }],
          { stepName, phase: 'action', retryable: false }
        );
      }

      if (totalBytes > spoolThreshold && !fileStream) {
        const spoolDir = options.spoolDir || os.tmpdir();
        filePath = path.join(spoolDir, `siglo-wh-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
        fileStream = fs.createWriteStream(filePath);
        for (const prev of chunks) {
          fileStream.write(prev);
        }
        chunks.length = 0;
      }

      if (fileStream) {
        fileStream.write(buf);
      } else {
        chunks.push(buf);
      }
    }

    if (fileStream) {
      await new Promise((resolve, reject) => {
        fileStream!.end(resolve);
        fileStream!.on('error', reject);
      });
      const fileBuf = fs.readFileSync(filePath!);
      return {
        rawPayload: fileBuf,
        payloadRef: {
          storage: 'file',
          path: filePath,
          bytes: totalBytes
        }
      };
    }

    const rawPayload = Buffer.concat(chunks);
    return {
      rawPayload,
      payloadRef: {
        storage: 'memory',
        bytes: totalBytes
      }
    };
  }

  const rawPayload = normalizeRawPayload(val);
  const byteLen = Buffer.isBuffer(rawPayload) ? rawPayload.length : Buffer.byteLength(rawPayload);

  if (maxBytes > 0 && byteLen > maxBytes) {
    throw new ValidationException(
      [{ field: 'payload', message: `Payload exceeds maximum allowed size of ${maxBytes} bytes` }],
      { stepName, phase: 'action', retryable: false }
    );
  }

  return {
    rawPayload,
    payloadRef: {
      storage: 'memory',
      bytes: byteLen
    }
  };
}

export class WebhookVerifyStep<TInput = any, TName extends string = string>
  extends Step<TInput, WebhookVerificationResult, TName>
{
  private verifyOptions: WebhookVerifyOptions<TInput>;

  constructor(name: TName, options: WebhookVerifyOptions<TInput>) {
    const action = async (ctx: TInput): Promise<WebhookVerificationResult> => {
      // 1. Resolve raw payload (supports Buffers, strings, and streaming chunks)
      const rawPayloadInput = options.payload(ctx);
      if (!isRawPayload(rawPayloadInput)) {
        throw new ValidationException(
          [{ field: 'payload', message: 'Payload must be a Buffer or raw unparsed string to prevent JSON serialization skew' }],
          { stepName: name, phase: 'action', retryable: false }
        );
      }

      const { rawPayload, payloadRef } = await resolvePayloadData(rawPayloadInput, options, name);

      // 2. Resolve secret
      const secret = typeof options.secret === 'function' ? options.secret(ctx) : options.secret;
      if (!secret) {
        throw new ValidationException(
          [{ field: 'secret', message: 'Webhook secret is required' }],
          { stepName: name, phase: 'action', retryable: false }
        );
      }

      // 3. Resolve protocol
      let providerOrProtocol = options.provider;
      if (typeof providerOrProtocol === 'function') {
        providerOrProtocol = providerOrProtocol(ctx);
      }
      if (!providerOrProtocol) {
        providerOrProtocol = 'generic-hmac';
      }

      let protocol: WebhookProtocol | undefined;
      if (typeof providerOrProtocol === 'string') {
        protocol = getWebhookProtocol(providerOrProtocol);
        if (!protocol) {
          throw new ValidationException(
            [{ field: 'provider', message: `Unknown webhook provider '${providerOrProtocol}'` }],
            { stepName: name, phase: 'action', retryable: false }
          );
        }
      } else {
        protocol = providerOrProtocol;
      }

      // 4. Resolve headers and signature header
      const signatureOrHeaders = options.signature(ctx);
      let headers: Record<string, string | string[] | undefined> = {};
      let signatureHeader = '';

      if (options.headers) {
        headers = options.headers(ctx);
      }

      if (typeof signatureOrHeaders === 'string') {
        signatureHeader = signatureOrHeaders;
        if (Object.keys(headers).length === 0 && (ctx as any)?.headers && typeof (ctx as any).headers === 'object') {
          headers = (ctx as any).headers;
        }
      } else if (typeof signatureOrHeaders === 'object' && signatureOrHeaders !== null) {
        headers = signatureOrHeaders;
      } else if ((ctx as any)?.headers && typeof (ctx as any).headers === 'object') {
        headers = (ctx as any).headers;
      }

      const normalized = normalizeHeaders(headers);

      // If signatureHeader is empty, resolve from common header keys based on provider
      if (!signatureHeader) {
        if (protocol.name === 'stripe') {
          signatureHeader = normalized['stripe-signature'] || '';
        } else if (protocol.name === 'github') {
          signatureHeader = normalized['x-hub-signature-256'] || normalized['x-hub-signature'] || '';
        } else if (protocol.name === 'shopify') {
          signatureHeader = normalized['x-shopify-hmac-sha256'] || '';
        } else if (protocol.name === 'slack') {
          signatureHeader = normalized['x-slack-signature'] || '';
        } else if (protocol.name === 'svix') {
          signatureHeader = normalized['svix-signature'] || normalized['webhook-signature'] || '';
        } else {
          signatureHeader = normalized['signature'] || normalized['x-signature'] || normalized['x-hub-signature-256'] || '';
        }
      }

      // 5. Parse headers & enforce replay attack tolerance
      const toleranceSeconds = options.toleranceSeconds ?? 300;
      let parsedTimestamp: number | undefined;

      if (protocol.parseHeaders) {
        const parsed = protocol.parseHeaders(headers, signatureHeader);
        if (!signatureHeader && parsed.signatures.length === 0) {
          throw new ValidationException(
            [{ field: 'signature', message: 'Webhook signature header is missing' }],
            { stepName: name, phase: 'action', retryable: false }
          );
        }
        if (parsed.timestamp !== undefined) {
          parsedTimestamp = parsed.timestamp;
          const nowSec = options.clock ? Math.floor(options.clock.now() / 1000) : Math.floor(Date.now() / 1000);
          let tsSec = parsed.timestamp;
          if (tsSec > 1e11) {
            tsSec = Math.floor(tsSec / 1000);
          }
          if (toleranceSeconds > 0 && Math.abs(nowSec - tsSec) > toleranceSeconds) {
            throw new ValidationException(
              [{ field: 'timestamp', message: `Webhook timestamp '${parsed.timestamp}' outside tolerance window (${toleranceSeconds}s)` }],
              { stepName: name, phase: 'action', retryable: false }
            );
          }
        }
      } else if (!signatureHeader) {
        throw new ValidationException(
          [{ field: 'signature', message: 'Webhook signature header is missing' }],
          { stepName: name, phase: 'action', retryable: false }
        );
      }

      // 6. Enforce intra-window replay defense via dedupStore
      const dedupKey = createDedupKey(protocol.name, signatureHeader, parsedTimestamp);
      if (options.dedupStore) {
        const claimed = await options.dedupStore.claim(dedupKey, toleranceSeconds);
        if (!claimed) {
          throw new ValidationException(
            [{ field: 'signature', message: `Replay detected: duplicate webhook signature within tolerance window (${toleranceSeconds}s)` }],
            { stepName: name, phase: 'action', retryable: false }
          );
        }
      }

      // 7. Execute protocol verification
      const isValid = await protocol.verify({
        secret,
        rawPayload,
        headers,
        signatureHeader,
        toleranceSeconds,
        clock: options.clock,
        algorithm: options.algorithm
      });

      if (!isValid) {
        throw new ValidationException(
          [{ field: 'signature', message: `Webhook signature verification failed for provider '${protocol.name}'` }],
          { stepName: name, phase: 'action', retryable: false }
        );
      }

      const verifiedAt = parsedTimestamp !== undefined
        ? parsedTimestamp
        : (options.clock ? Math.floor(options.clock.now() / 1000) : Math.floor(Date.now() / 1000));

      return {
        webhookVerified: true as const,
        verifiedAt,
        provider: protocol.name,
        idempotencyKey: dedupKey,
        payloadRef
      };
    };

    super(name, action as any);
    this.verifyOptions = options;

    // 1. BEFORE Phase: Early assertions
    this.onBefore(async (ctx: TInput) => {
      const payload = options.payload(ctx);
      if (!isRawPayload(payload)) {
        throw new ValidationException(
          [{ field: 'payload', message: 'Payload must be a Buffer or raw unparsed string to prevent JSON serialization skew' }],
          { stepName: name, phase: 'before', retryable: false }
        );
      }

      let provider = options.provider;
      if (typeof provider === 'function') {
        provider = provider(ctx);
      }
      if (typeof provider === 'string') {
        const protocol = getWebhookProtocol(provider);
        if (!protocol) {
          throw new ValidationException(
            [{ field: 'provider', message: `Unknown webhook provider '${provider}'` }],
            { stepName: name, phase: 'before', retryable: false }
          );
        }
      }

      return true;
    });
  }

  override execute(param?: TInput, options?: ExecutionOptions): Promise<WebhookVerificationResult> {
    const cleanParam = param ? sanitizeStepInput(param) : param;
    return super.execute(cleanParam, { pojo: true, ...options });
  }

  override run(param?: TInput, options?: ExecutionOptions): Promise<WebhookVerificationResult> {
    return this.execute(param, options);
  }
}

/**
 * Factory for generating typed webhook verification steps.
 */
export function verifyWebhookStep<const TName extends string, TInput>(
  name: TName,
  options: WebhookVerifyOptions<TInput>
): WebhookVerifyStep<TInput, TName> {
  return new WebhookVerifyStep<TInput, TName>(name, options);
}
