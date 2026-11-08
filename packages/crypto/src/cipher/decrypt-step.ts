import { Step, ValidationException, ExecutionOptions } from '@siglo/core';
import { FieldCipherOptions, KeyRing } from '../types';
import { decryptAESGCM, isEncryptedEnvelope } from './aes-gcm';
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

export class DecryptFieldsStep<TInput = any, TName extends string = string> extends Step<TInput, TInput, TName> {
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
                    [{ field: 'secretKey', message: 'Secret key or KeyRing is required for decryption' }],
                    { stepName: name, phase: 'action', retryable: false },
                );
            }

            // 2. Resolve optional AAD and deriveKeyContext
            const resolvedAad = typeof options.aad === 'function' ? options.aad(ctx) : options.aad;
            const resolvedDeriveCtx =
                typeof options.deriveKeyContext === 'function'
                    ? options.deriveKeyContext(ctx)
                    : options.deriveKeyContext;

            let hasRekeyNeeded = false;

            // 3. Decrypt fields using structural sharing
            const result = transformFields(ctx, options.fields as any, (val, concretePath) => {
                if (!isEncryptedEnvelope(val)) {
                    return val;
                }

                const fieldName = concretePath.join('.');

                // Resolve key for this specific envelope
                let keyToUse: string | Buffer | null | undefined;
                let activeKid: string | undefined;

                if (isKeyRing(keyOrRing)) {
                    const active = keyOrRing.getActiveKey();
                    activeKid = active instanceof Promise ? undefined : active.kid;

                    if (val.kid) {
                        keyToUse = keyOrRing.getKey(val.kid) as any;
                        if (!keyToUse) {
                            throw new ValidationException(
                                [
                                    {
                                        field: fieldName,
                                        message: `Failed to decrypt field '${fieldName}': key ID '${val.kid}' not found in KeyRing`,
                                    },
                                ],
                                { stepName: name, phase: 'action', retryable: false },
                            );
                        }
                        if (activeKid && val.kid !== activeKid) {
                            hasRekeyNeeded = true;
                            if (options.onNeedsRekey) {
                                options.onNeedsRekey(ctx, fieldName, val.kid, activeKid);
                            }
                        }
                    } else {
                        // Legacy envelope without kid: try active key
                        const activeRes = active instanceof Promise ? undefined : active;
                        keyToUse = activeRes?.key;
                    }
                } else {
                    keyToUse = keyOrRing;
                }

                if (!keyToUse) {
                    throw new ValidationException(
                        [{ field: fieldName, message: `Failed to resolve decryption key for field '${fieldName}'` }],
                        { stepName: name, phase: 'action', retryable: false },
                    );
                }

                try {
                    return decryptAESGCM(val, keyToUse, {
                        aad: resolvedAad,
                        deriveKeyContext: resolvedDeriveCtx,
                    });
                } catch (err: any) {
                    throw new ValidationException(
                        [
                            {
                                field: fieldName,
                                message: `Failed to decrypt field '${fieldName}': authentication tag verification failed`,
                            },
                        ],
                        { stepName: name, phase: 'action', retryable: false, cause: err },
                    );
                }
            });

            if (hasRekeyNeeded && !options.onNeedsRekey && typeof result === 'object' && result !== null) {
                (result as any).$needsRekey = true;
            }

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
 * Creates a step that decrypts encrypted context envelopes in-place back to their plaintext values.
 * Supports dot-notation paths, KeyRing rotation, AAD verification, and lazy checkpoint re-key flags.
 */
export function decryptFieldsStep<const TName extends string, TInput>(
    name: TName,
    options: FieldCipherOptions<TInput>,
): DecryptFieldsStep<TInput, TName> {
    return new DecryptFieldsStep<TInput, TName>(name, options);
}
