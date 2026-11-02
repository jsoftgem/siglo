/** Built-in provider preset identifiers with open string autocomplete */
export type BuiltInWebhookProvider = 'stripe' | 'github' | 'shopify' | 'slack' | 'svix' | 'generic-hmac';
export type WebhookProviderName = BuiltInWebhookProvider | (string & {});

export interface WebhookProtocolVerificationParams {
  secret: string | Buffer;
  rawPayload: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  signatureHeader: string;
  toleranceSeconds?: number;
  clock?: { now(): number };
  algorithm?: 'sha256' | 'sha512' | 'sha1';
}

export interface ParsedWebhookHeaders {
  timestamp?: number;
  signatures: string[];
  version?: string;
}

export interface WebhookProtocol {
  name: string;

  /** Parses timestamps, signatures, and version identifiers from raw headers */
  parseHeaders?(
    headers: Record<string, string | string[] | undefined>,
    signatureHeader: string
  ): ParsedWebhookHeaders;

  /** Formats the exact string or buffer to be signed (e.g. `${timestamp}.${rawBody}`) */
  formatSignedPayload?(rawBody: string | Buffer, timestamp?: number): string | Buffer;

  /** Custom verification logic (HMAC, asymmetric Ed25519, RSA, etc.) */
  verify(params: WebhookProtocolVerificationParams): Promise<boolean> | boolean;
}

/** Nonce / signature deduplication store interface */
export interface WebhookDedupStore {
  claim(key: string, ttlSeconds: number): Promise<boolean> | boolean;
}

/** Reference to spooled or stream-verified payload */
export interface WebhookPayloadRef {
  storage: 'memory' | 'file';
  path?: string;
  bytes: number;
}

export interface WebhookVerifyOptions<TInput> {
  /**
   * Built-in provider name, registered protocol name, custom WebhookProtocol instance,
   * or dynamic resolver function based on workflow context.
   */
  provider?: WebhookProviderName | WebhookProtocol | ((ctx: TInput) => WebhookProviderName | WebhookProtocol);

  /** Webhook signing secret (or public key for asymmetric protocols) */
  secret: string | Buffer | ((ctx: TInput) => string | Buffer);

  /** Raw unparsed payload buffer, UTF-8 string, or Readable stream / AsyncIterable */
  payload: (ctx: TInput) => string | Buffer | NodeJS.ReadableStream | AsyncIterable<Buffer>;

  /** Signature header string or entire headers dictionary */
  signature: (ctx: TInput) => string | Record<string, string | string[] | undefined>;

  /** Optional headers extractor if signature returns only the signature string */
  headers?: (ctx: TInput) => Record<string, string | string[] | undefined>;

  /** Hash algorithm for generic HMAC (default: 'sha256') */
  algorithm?: 'sha256' | 'sha512' | 'sha1';

  /** Max allowed difference between current time and signature timestamp in seconds (default: 300) */
  toleranceSeconds?: number;

  /** Optional clock interface for deterministic time testing */
  clock?: { now(): number };

  /** Deduplication store for intra-window replay protection */
  dedupStore?: WebhookDedupStore;

  /** Maximum allowed payload size in bytes before rejecting with 413 ValidationException (default: 10MB) */
  maxBodyBytes?: number;

  /** Byte threshold above which streaming payloads are spooled to ephemeral disk (default: 5MB) */
  spoolThresholdBytes?: number;

  /** Directory for ephemeral disk spooling (default: os.tmpdir()) */
  spoolDir?: string;
}

export interface WebhookVerificationResult {
  webhookVerified: true;
  verifiedAt: number;
  provider: string;
  idempotencyKey?: string;
  payloadRef?: WebhookPayloadRef;
}

// ==========================================
// Envelope Encryption & Field Masking Types
// ==========================================

export interface EncryptedEnvelope {
  __sigloCipher: 'aes-256-gcm';
  v?: number;          // Envelope schema version (default: 1)
  kid?: string;        // Active Key ID at encryption time
  iv: string;          // Hex encoded 12-byte IV
  tag: string;         // Hex encoded 16-byte auth tag
  data: string;        // Hex encoded ciphertext
  edek?: string;       // Optional base64 wrapped DEK for cloud KMS
  kekId?: string;      // Optional KMS Key ARN / Identifier
}

export interface KeyRingKey {
  kid: string;
  key: string | Buffer;
}

export interface KeyRing {
  getActiveKey(): Promise<KeyRingKey> | KeyRingKey;
  getKey(kid: string): Promise<string | Buffer | null | undefined> | string | Buffer | null | undefined;
}

export interface FieldCipherOptions<TInput> {
  /** Fields to encrypt/decrypt. Supports top-level keys or dot-notation paths (e.g. 'billing.card.number', 'items.*.token') */
  fields: (keyof TInput | string)[];

  /** Secret key string, Buffer, KeyRing instance, or dynamic resolver callback */
  secretKey?: string | Buffer | KeyRing | ((ctx: TInput) => string | Buffer | KeyRing | Promise<string | Buffer | KeyRing>);

  /** KeyRing instance for multi-key rotation and checkpoint archaeology */
  keyRing?: KeyRing;

  /** Optional Additional Authenticated Data (AAD) for tenant/context isolation */
  aad?: string | Buffer | ((ctx: TInput) => string | Buffer | undefined);

  /** Optional HKDF context info for deriving per-workflow/tenant subkeys */
  deriveKeyContext?: string | Buffer | ((ctx: TInput) => string | Buffer | undefined);

  /** Callback invoked when a decrypted envelope was encrypted with a retired/historical key */
  onNeedsRekey?: (ctx: TInput, field: string, oldKid?: string, activeKid?: string) => void;
}

export interface MaskFieldsOptions<TInput> {
  /** Fields to mask. Supports top-level keys or dot-notation paths (e.g. 'user.ssn', 'passengers.*.passport') */
  fields: (keyof TInput | string)[];

  /** Custom or preset mask function */
  maskPattern?: (value: unknown) => string;
}
