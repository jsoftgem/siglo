import { ValidationException, ValidationErrorDetail, getErrorMessage } from '@siglo/core';

interface ValidationIssueLike {
    path?: Array<{ key?: unknown } | string | number>;
    message?: string;
}

interface StandardSchemaLike {
    '~standard': {
        validate: (
            data: unknown,
        ) =>
            | Promise<{ issues?: readonly ValidationIssueLike[]; value?: unknown }>
            | { issues?: readonly ValidationIssueLike[]; value?: unknown };
    };
}

interface SafeParseSchemaLike {
    safeParse: (data: unknown) =>
        | Promise<{
              success: boolean;
              data?: unknown;
              error?: { issues?: readonly ValidationIssueLike[]; message?: string };
          }>
        | { success: boolean; data?: unknown; error?: { issues?: readonly ValidationIssueLike[]; message?: string } };
}

interface ParseSchemaLike {
    parse: (data: unknown) => Promise<unknown> | unknown;
}

interface ValidateSchemaLike {
    validate: (data: unknown) =>
        | Promise<
              | {
                    error?: { details?: Array<{ path?: string | unknown[]; message?: string }>; message?: string };
                    value?: unknown;
                }
              | unknown
          >
        | {
              error?: { details?: Array<{ path?: string | unknown[]; message?: string }>; message?: string };
              value?: unknown;
          }
        | unknown;
}

function attachPhase(exception: ValidationException, phase: 'validation' | 'action'): void {
    Object.defineProperty(exception, 'phase', {
        get: () => phase,
        set: () => {},
        configurable: true,
    });
}

export interface ValidationResult<T = any> {
    success: boolean;
    data?: T;
    errors?: ValidationErrorDetail[];
}

/**
 * Validates a payload against a Standard Schema (~standard), Zod, Valibot, ArkType,
 * or standard parsing validator.
 *
 * If validation fails, throws a Siglo ValidationException tagged with the provided phase.
 */
export async function validatePayload<T = any>(
    schema: unknown,
    data: unknown,
    phase: 'validation' | 'action',
    stepName?: string,
): Promise<T> {
    if (!schema) {
        return data as T;
    }

    // 1. Standard Schema specification (~standard v1)
    if (
        typeof schema === 'object' &&
        schema !== null &&
        '~standard' in schema &&
        (schema as StandardSchemaLike)['~standard']
    ) {
        const standard = (schema as StandardSchemaLike)['~standard'];
        const result = await standard.validate(data);
        if (result && result.issues) {
            const details: ValidationErrorDetail[] = result.issues.map(issue => ({
                field:
                    issue.path && issue.path.length > 0
                        ? issue.path
                              .map(segment =>
                                  String(
                                      typeof segment === 'object' && segment !== null ? (segment.key ?? '') : segment,
                                  ),
                              )
                              .join('.')
                        : '$root$',
                message: issue.message || 'Validation failed',
                error: issue,
            }));
            const exception = new ValidationException(details, { phase, stepName, retryable: false });
            attachPhase(exception, phase);
            throw exception;
        }
        if (!result || !('value' in result)) {
            throw new TypeError('Standard Schema validator must return value or issues');
        }
        return result.value as T;
    }

    // 2. safeParse (Zod, Valibot, etc.)
    if (
        typeof schema === 'object' &&
        schema !== null &&
        'safeParse' in schema &&
        typeof (schema as SafeParseSchemaLike).safeParse === 'function'
    ) {
        const result = await (schema as SafeParseSchemaLike).safeParse(data);
        if (!result.success) {
            const issues = result.error?.issues;
            const details: ValidationErrorDetail[] =
                Array.isArray(issues) && issues.length > 0
                    ? issues.map(i => ({
                          field: i.path && i.path.length > 0 ? i.path.join('.') : '$root$',
                          message: i.message || 'Validation failed',
                          error: i,
                      }))
                    : [
                          {
                              field: '$root$',
                              message: result.error?.message || 'Schema validation failed',
                              error: result.error,
                          },
                      ];
            const exception = new ValidationException(details, { phase, stepName, retryable: false });
            attachPhase(exception, phase);
            throw exception;
        }
        return result.data as T;
    }

    // 3. parse() method (Zod synchronous/asynchronous parser)
    if (
        typeof schema === 'object' &&
        schema !== null &&
        'parse' in schema &&
        typeof (schema as ParseSchemaLike).parse === 'function'
    ) {
        try {
            const parsed = await (schema as ParseSchemaLike).parse(data);
            return (parsed !== undefined ? parsed : data) as T;
        } catch (err: unknown) {
            const errObj =
                typeof err === 'object' && err !== null
                    ? (err as { issues?: ValidationIssueLike[]; message?: unknown })
                    : undefined;
            const issues = errObj?.issues;
            const details: ValidationErrorDetail[] =
                Array.isArray(issues) && issues.length > 0
                    ? issues.map(i => ({
                          field: i.path && i.path.length > 0 ? i.path.join('.') : '$root$',
                          message: i.message || 'Validation failed',
                          error: i,
                      }))
                    : [
                          {
                              field: '$root$',
                              message:
                                  typeof errObj?.message === 'string' && errObj.message
                                      ? errObj.message
                                      : 'Schema validation failed',
                              error: err,
                          },
                      ];
            const exception = new ValidationException(details, { phase, stepName, retryable: false });
            attachPhase(exception, phase);
            throw exception;
        }
    }

    // 4. validate() method (Joi, Yup, etc.)
    if (
        typeof schema === 'object' &&
        schema !== null &&
        'validate' in schema &&
        typeof (schema as ValidateSchemaLike).validate === 'function'
    ) {
        try {
            const result = await (schema as ValidateSchemaLike).validate(data);
            // Yup returns parsed data, Joi returns { error, value }
            const joiResult =
                result && typeof result === 'object'
                    ? (result as {
                          error?: {
                              details?: Array<{ path?: string | unknown[]; message?: string }>;
                              message?: string;
                          };
                          value?: unknown;
                      })
                    : undefined;
            if (joiResult && 'error' in joiResult && joiResult.error) {
                const details: ValidationErrorDetail[] = Array.isArray(joiResult.error.details)
                    ? joiResult.error.details.map(d => ({
                          field: d.path ? (Array.isArray(d.path) ? d.path.join('.') : String(d.path)) : '$root$',
                          message: d.message || 'Validation failed',
                          error: d,
                      }))
                    : [
                          {
                              field: '$root$',
                              message: joiResult.error.message || 'Validation failed',
                              error: joiResult.error,
                          },
                      ];
                const exception = new ValidationException(details, { phase, stepName, retryable: false });
                attachPhase(exception, phase);
                throw exception;
            }
            return (joiResult && 'value' in joiResult ? joiResult.value : result) as T;
        } catch (err: unknown) {
            if (err instanceof ValidationException) throw err;
            const exception = new ValidationException(
                [{ field: '$root$', message: getErrorMessage(err) || 'Validation failed', error: err }],
                { phase, stepName, retryable: false },
            );
            attachPhase(exception, phase);
            throw exception;
        }
    }

    // 5. Function validator (custom predicate / mapper)
    if (typeof schema === 'function') {
        try {
            const result = await (schema as (d: unknown) => unknown)(data);
            if (result === false) {
                throw new Error('Custom validation function returned false');
            }
            return (result !== true && result !== undefined ? result : data) as T;
        } catch (err: unknown) {
            const exception = new ValidationException(
                [{ field: '$root$', message: getErrorMessage(err) || 'Validation failed', error: err }],
                { phase, stepName, retryable: false },
            );
            attachPhase(exception, phase);
            throw exception;
        }
    }

    return data as T;
}
