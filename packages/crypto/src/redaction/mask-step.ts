import { Step, ExecutionOptions } from '@siglo/core';
import { MaskFieldsOptions } from '../types';
import { transformFields } from './paths';

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
 * Common masking pattern presets for PII sanitization.
 */
export const maskPatterns = {
  /** Replaces entire value with [REDACTED] */
  redact: (_value: unknown): string => '[REDACTED]',

  /** Keeps the last 4 characters visible; masks earlier characters with asterisks */
  last4: (value: unknown): string => {
    const str = String(value ?? '');
    if (str.length <= 4) {
      return '*'.repeat(str.length || 4);
    }
    return '*'.repeat(str.length - 4) + str.slice(-4);
  },

  /** Formats digits as masked credit card number: ****-****-****-1234 */
  creditCard: (value: unknown): string => {
    const digits = String(value ?? '').replace(/\D/g, '');
    const last4 = digits.slice(-4) || '****';
    return `****-****-****-${last4}`;
  },

  /** Formats digits as masked US Social Security Number: ***-**-1234 */
  ssn: (value: unknown): string => {
    const digits = String(value ?? '').replace(/\D/g, '');
    const last4 = digits.slice(-4) || '****';
    return `***-**-${last4}`;
  },

  /** Masks email local-part: j***@example.com */
  email: (value: unknown): string => {
    const str = String(value ?? '');
    const atIdx = str.indexOf('@');
    if (atIdx <= 1) {
      return str.replace(/^./, '*') || '***';
    }
    return `${str[0]}***${str.slice(atIdx)}`;
  }
};

export class MaskFieldsStep<TInput = any, TName extends string = string>
  extends Step<TInput, TInput, TName>
{
  constructor(name: TName, options: MaskFieldsOptions<TInput>) {
    const action = async (ctx: TInput): Promise<TInput> => {
      const maskFn = options.maskPattern || maskPatterns.last4;

      const result = transformFields(ctx, options.fields as any, (val) => {
        if (val !== undefined && val !== null) {
          return maskFn(val);
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
 * Creates a step that masks sensitive context fields before DevTools/telemetry emission.
 * Supports dot-notation paths, array wildcards, and structural sharing.
 */
export function maskFieldsStep<const TName extends string, TInput>(
  name: TName,
  options: MaskFieldsOptions<TInput>
): MaskFieldsStep<TInput, TName> {
  return new MaskFieldsStep<TInput, TName>(name, options);
}
