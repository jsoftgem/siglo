import { Step, ValidationException, ExecutionOptions } from '@siglo/core';
import { FieldCipherOptions, KeyRing } from '../types';
import { encryptAESGCM, isEncryptedEnvelope } from './aes-gcm';
import { isKeyRing } from './key-ring';
import { transformFields } from '../redaction/paths';

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

export class EncryptFieldsStep<TInput = any, TName extends string = string> extends Step<TInput, TInput, TName> {
    constructor(name: TName, options: FieldCipherOptions<TInput>) {
        const action = async (ctx: TInput): Promise<TInput> => {
            // 1. Resolve key or KeyRing
            let keyOrRing: string | Buffer | KeyRing | undefined;
            if (options.keyRing) {
                keyOrRing = options.keyRing;
            } else if (typeof options.secretKey === 'function') {
                keyOrRing = await options.secretKey(ctx);
            } else {
                keyOrRing = options.secretKey;
            }

            if (!keyOrRing) {
                throw new ValidationException(
                    [{ field: 'secretKey', message: 'Secret key or KeyRing is required for encryption' }],
                    { stepName: name, phase: 'action', retryable: false },
                );
            }

            let activeKey: string | Buffer;
            let activeKid: string | undefined;

            if (isKeyRing(keyOrRing)) {
                const active = await keyOrRing.getActiveKey();
                activeKey = active.key;
                activeKid = active.kid;
            } else {
                activeKey = keyOrRing;
            }

            // 2. Resolve optional AAD and deriveKeyContext
            const resolvedAad = typeof options.aad === 'function' ? options.aad(ctx) : options.aad;
            const resolvedDeriveCtx =
                typeof options.deriveKeyContext === 'function'
                    ? options.deriveKeyContext(ctx)
                    : options.deriveKeyContext;

            // 3. Encrypt target fields using structural sharing
            const result = transformFields(ctx, options.fields as any, val => {
                if (val !== undefined && val !== null && !isEncryptedEnvelope(val)) {
                    return encryptAESGCM(val, activeKey, {
                        kid: activeKid,
                        aad: resolvedAad,
                        deriveKeyContext: resolvedDeriveCtx,
                    });
                }
                return val;
            });

            return result;
        };

        super(name, action as any);
    }

    override execute(param?: TInput, options?: ExecutionOptions): Promise<TInput> {
        const cleanParam = param ? sanitizeStepInput(param) : param;
        return super.execute(cleanParam, { pojo: true, ...options });
    }

    override run(param?: TInput, options?: ExecutionOptions): Promise<TInput> {
        return this.execute(param, options);
    }
}

/**
 * Creates a step that encrypts specified context fields in-place using AES-256-GCM envelope encryption.
 * Supports dot-notation paths, wildcards, KeyRing rotation, AAD, and HKDF key derivation.
 */
export function encryptFieldsStep<const TName extends string, TInput>(
    name: TName,
    options: FieldCipherOptions<TInput>,
): EncryptFieldsStep<TInput, TName> {
    return new EncryptFieldsStep<TInput, TName>(name, options);
}
