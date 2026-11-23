import { ExecutionPhase, isObject, isReservedKey, tagErrorPhase } from '../../shared';
import { NetworkPolicyViolationException, ValidationErrorDetail, ValidationException } from '../executer/exceptions';

export type SyncValue<T> = T extends PromiseLike<any> ? never : T;

export type SyncSpecAction = 'default' | 'require' | 'validate' | 'transform' | 'translate' | 'schema';

export interface SyncSpecData {
    defaultValue?: any;
    default?: any;
    require?: boolean | (() => boolean);
    requireMessage?: string;
    validator?: (currentValue?: any) => SyncValue<any>;
    validate?: (currentValue?: any) => SyncValue<any>;
    transformer?: (currentValue?: any) => SyncValue<any>;
    transform?: (currentValue?: any) => SyncValue<any>;
    translator?: (currentValue?: any, context?: Record<string, any>) => SyncValue<void>;
    translate?: (currentValue?: any, context?: Record<string, any>) => SyncValue<void>;
    schema?: any;
}

export function isThenable(value: unknown): value is PromiseLike<any> {
    return (
        value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof (value as any).then === 'function'
    );
}

function suppressUnhandledRejection(thenable: PromiseLike<any>): void {
    if (thenable instanceof Promise) {
        thenable.catch(() => {});
    }
}

function isNetworkViolation(err: unknown): boolean {
    return (
        err instanceof NetworkPolicyViolationException ||
        (isObject(err) && (err as any).name === 'NetworkPolicyViolationException')
    );
}

export class SyncSpec {
    readonly field: string;
    readonly actions: SyncSpecAction[];
    data: SyncSpecData;

    constructor(field: string) {
        if (!field) {
            throw new Error('Field name is required.');
        }
        this.field = field;
        this.actions = [];
        this.data = {};
    }

    default(defaultValue: any): void {
        this.actions.push('default');
        this.data = { ...this.data, defaultValue };
    }

    require(requireVal: boolean | (() => boolean), requireMessage?: string): void {
        this.actions.push('require');
        this.data = { ...this.data, require: requireVal, requireMessage };
    }

    validate(validator: (currentValue?: any) => SyncValue<any>): void {
        this.actions.push('validate');
        this.data = { ...this.data, validator };
    }

    transform(transformer: (currentValue?: any) => SyncValue<any>): void {
        this.actions.push('transform');
        this.data = { ...this.data, transformer };
    }

    translate(translator: (currentValue?: any, context?: Record<string, any>) => SyncValue<void>): void {
        this.actions.push('translate');
        this.data = { ...this.data, translator };
    }

    schema(schemaObj: any): void {
        this.actions.push('schema');
        this.data = { ...this.data, schema: schemaObj };
    }
}

function applySchemaValue(data: Record<string, any>, field: string, isRoot: boolean, value: any): void {
    if (value === undefined) {
        return;
    }
    if (isRoot && isObject(value) && !Array.isArray(value)) {
        Object.assign(data, value);
    } else if (!isRoot) {
        data[field] = value;
    }
}

function formatSchemaIssues(issues: any[]): string {
    return issues
        .map((issue: any) => {
            const pathStr = issue.path && issue.path.length ? issue.path.join('.') + ': ' : '';
            return `${pathStr}${issue.message || 'Validation failed'}`;
        })
        .join('; ');
}

function throwAsyncSpecError(field: string, kind: string, stepName?: string): never {
    const message = `Async ${kind} is forbidden in Step.compute for field "${field}". Use Step.create for async validation.`;
    throw new ValidationException([{ field, message }], {
        stepName,
        phase: ExecutionPhase.VALIDATION,
    });
}

function runSchemaSync(
    spec: SyncSpec,
    data: Record<string, any>,
    errors: ValidationErrorDetail[],
    stepName?: string,
): void {
    const schema = spec.data.schema;
    if (!schema) {
        return;
    }

    const field = spec.field;
    const isRoot = field === '$root$';

    let targetValue: any;
    if (isRoot) {
        targetValue = {};
        for (const key of Object.keys(data)) {
            if (!isReservedKey(key)) {
                targetValue[key] = data[key];
            }
        }
    } else {
        targetValue = data[field];
    }

    // 1. Standard Schema (~standard specification)
    if (isObject(schema) && schema['~standard']) {
        const result = schema['~standard'].validate(targetValue);
        if (isThenable(result)) {
            suppressUnhandledRejection(result);
            throwAsyncSpecError(field, 'schema', stepName);
        }
        if (result && result.issues && result.issues.length > 0) {
            errors.push({ field, message: formatSchemaIssues(result.issues) });
            return;
        }
        applySchemaValue(data, field, isRoot, result?.value);
        return;
    }

    // 2. safeParse (Zod, Valibot, etc.)
    if (isObject(schema) && typeof schema.safeParse === 'function') {
        const result = schema.safeParse(targetValue);
        if (isThenable(result)) {
            suppressUnhandledRejection(result);
            throwAsyncSpecError(field, 'schema', stepName);
        }
        if (!result.success) {
            const issues = result.error?.issues;
            const message =
                issues && issues.length
                    ? formatSchemaIssues(issues)
                    : result.error?.message || 'Schema validation failed';
            errors.push({ field, message });
            return;
        }
        applySchemaValue(data, field, isRoot, result.data);
        return;
    }

    // 3. parse() method (Zod / custom parser)
    if (isObject(schema) && typeof schema.parse === 'function') {
        const parsed = schema.parse(targetValue);
        if (isThenable(parsed)) {
            suppressUnhandledRejection(parsed);
            throwAsyncSpecError(field, 'schema', stepName);
        }
        applySchemaValue(data, field, isRoot, parsed);
        return;
    }

    // 4. validate() method (Joi, Yup, custom sync validator)
    if (isObject(schema) && typeof schema.validate === 'function') {
        const validated = schema.validate(targetValue);
        if (isThenable(validated)) {
            suppressUnhandledRejection(validated);
            throwAsyncSpecError(field, 'schema', stepName);
        }
        applySchemaValue(data, field, isRoot, validated);
        return;
    }

    // 5. Function predicate validator
    if (typeof schema === 'function') {
        const valid = schema(targetValue);
        if (isThenable(valid)) {
            suppressUnhandledRejection(valid);
            throwAsyncSpecError(field, 'schema', stepName);
        }
        if (valid === false) {
            errors.push({ field, message: `Validation failed for field "${field}"` });
        }
    }
}

export function runSpecsSync(specs: SyncSpec[], input: Record<string, any>, stepName?: string): Record<string, any> {
    const data: Record<string, any> = isObject(input) ? { ...input } : {};
    const errors: ValidationErrorDetail[] = [];

    for (const spec of specs) {
        const field = spec.field;

        for (const action of spec.actions) {
            try {
                if (action === 'default') {
                    if (data[field] === undefined) {
                        data[field] = spec.data.defaultValue;
                    }
                } else if (action === 'require') {
                    const req = spec.data.require;
                    const isRequired = typeof req === 'function' ? req() : req;
                    if (isThenable(isRequired)) {
                        suppressUnhandledRejection(isRequired);
                        throwAsyncSpecError(field, 'require', stepName);
                    }
                    if (isRequired && (data[field] === undefined || data[field] === null || data[field] === '')) {
                        errors.push({
                            field,
                            message: spec.data.requireMessage || `Field ${field} is required.`,
                        });
                    }
                } else if (action === 'validate') {
                    const validator = spec.data.validator;
                    if (validator) {
                        const result = validator(data[field]);
                        if (isThenable(result)) {
                            suppressUnhandledRejection(result);
                            throwAsyncSpecError(field, 'validator', stepName);
                        }
                        if (result === false) {
                            errors.push({
                                field,
                                message: `Validation failed for field "${field}"`,
                            });
                        }
                    }
                } else if (action === 'transform') {
                    const transformer = spec.data.transformer;
                    if (transformer && data[field] !== undefined) {
                        const transformed = transformer(data[field]);
                        if (isThenable(transformed)) {
                            suppressUnhandledRejection(transformed);
                            throwAsyncSpecError(field, 'transformer', stepName);
                        }
                        data[field] = transformed;
                    }
                } else if (action === 'translate') {
                    const translator = spec.data.translator;
                    if (translator && data[field] !== undefined) {
                        const res = translator(data[field], data);
                        if (isThenable(res)) {
                            suppressUnhandledRejection(res);
                            throwAsyncSpecError(field, 'translator', stepName);
                        }
                    }
                } else if (action === 'schema') {
                    runSchemaSync(spec, data, errors, stepName);
                }
            } catch (err: any) {
                if (err instanceof ValidationException) {
                    throw err;
                }
                if (isNetworkViolation(err)) {
                    tagErrorPhase(err, ExecutionPhase.VALIDATION, stepName);
                    throw err;
                }
                errors.push({
                    field,
                    error: err,
                    message: err?.message || String(err),
                });
            }
        }
    }

    if (errors.length > 0) {
        throw new ValidationException(errors, {
            stepName,
            phase: ExecutionPhase.VALIDATION,
        });
    }

    return data;
}
