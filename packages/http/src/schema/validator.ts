import { ValidationException, ValidationErrorDetail } from '@siglo/core';

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
    schema: any,
    data: unknown,
    phase: 'validation' | 'action',
    stepName?: string,
): Promise<T> {
    if (!schema) {
        return data as T;
    }

    // 1. Standard Schema specification (~standard v1)
    if (typeof schema === 'object' && schema !== null && schema['~standard']) {
        const standard = schema['~standard'];
        const result = await standard.validate(data);
        if (result && result.issues) {
            const details: ValidationErrorDetail[] = result.issues.map((issue: any) => ({
                field:
                    issue.path && issue.path.length > 0
                        ? issue.path
                              .map((segment: any) =>
                                  String(typeof segment === 'object' && segment !== null ? segment.key : segment),
                              )
                              .join('.')
                        : '$root$',
                message: issue.message || 'Validation failed',
                error: issue,
            }));
            const exception = new ValidationException(details, { phase, stepName, retryable: false });
            Object.defineProperty(exception, 'phase', {
                get: () => phase,
                set: () => {},
                configurable: true,
            });
            throw exception;
        }
        if (!result || !('value' in result)) {
            throw new TypeError('Standard Schema validator must return value or issues');
        }
        return result.value as T;
    }

    // 2. safeParse (Zod, Valibot, etc.)
    if (typeof schema.safeParse === 'function') {
        const result = await schema.safeParse(data);
        if (!result.success) {
            const issues = result.error?.issues;
            const details: ValidationErrorDetail[] =
                Array.isArray(issues) && issues.length > 0
                    ? issues.map((i: any) => ({
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
            Object.defineProperty(exception, 'phase', {
                get: () => phase,
                set: () => {},
                configurable: true,
            });
            throw exception;
        }
        return result.data as T;
    }

    // 3. parse() method (Zod synchronous/asynchronous parser)
    if (typeof schema.parse === 'function') {
        try {
            const parsed = await schema.parse(data);
            return (parsed !== undefined ? parsed : data) as T;
        } catch (err: any) {
            const issues = err?.issues;
            const details: ValidationErrorDetail[] =
                Array.isArray(issues) && issues.length > 0
                    ? issues.map((i: any) => ({
                          field: i.path && i.path.length > 0 ? i.path.join('.') : '$root$',
                          message: i.message || 'Validation failed',
                          error: i,
                      }))
                    : [
                          {
                              field: '$root$',
                              message: err?.message || 'Schema validation failed',
                              error: err,
                          },
                      ];
            const exception = new ValidationException(details, { phase, stepName, retryable: false });
            Object.defineProperty(exception, 'phase', {
                get: () => phase,
                set: () => {},
                configurable: true,
            });
            throw exception;
        }
    }

    // 4. validate() method (Joi, Yup, etc.)
    if (typeof schema.validate === 'function') {
        try {
            const result = await schema.validate(data);
            // Yup returns parsed data, Joi returns { error, value }
            if (result && typeof result === 'object' && 'error' in result && result.error) {
                const details: ValidationErrorDetail[] = Array.isArray(result.error.details)
                    ? result.error.details.map((d: any) => ({
                          field: d.path ? (Array.isArray(d.path) ? d.path.join('.') : String(d.path)) : '$root$',
                          message: d.message || 'Validation failed',
                          error: d,
                      }))
                    : [{ field: '$root$', message: result.error.message || 'Validation failed', error: result.error }];
                const exception = new ValidationException(details, { phase, stepName, retryable: false });
                Object.defineProperty(exception, 'phase', {
                    get: () => phase,
                    set: () => {},
                    configurable: true,
                });
                throw exception;
            }
            return (result && 'value' in result ? result.value : result) as T;
        } catch (err: any) {
            if (err instanceof ValidationException) throw err;
            const exception = new ValidationException(
                [{ field: '$root$', message: err?.message || 'Validation failed', error: err }],
                { phase, stepName, retryable: false },
            );
            Object.defineProperty(exception, 'phase', {
                get: () => phase,
                set: () => {},
                configurable: true,
            });
            throw exception;
        }
    }

    // 5. Function validator (custom predicate / mapper)
    if (typeof schema === 'function') {
        try {
            const result = await schema(data);
            if (result === false) {
                throw new Error('Custom validation function returned false');
            }
            return (result !== true && result !== undefined ? result : data) as T;
        } catch (err: any) {
            const exception = new ValidationException(
                [{ field: '$root$', message: err?.message || 'Validation failed', error: err }],
                { phase, stepName, retryable: false },
            );
            Object.defineProperty(exception, 'phase', {
                get: () => phase,
                set: () => {},
                configurable: true,
            });
            throw exception;
        }
    }

    return data as T;
}
