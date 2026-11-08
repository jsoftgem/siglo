import { Defaults } from './defaults';
import { SpecFailedException } from './SpecFailedException';
import { Transformer } from './transformer';
import { Translator } from './translator';
import { Validators } from './validators';

export interface SpecData {
    defaultValue?: any;
    default?: any;
    require?: boolean | (() => boolean);
    requireMessage?: string;
    validator?: (currentValue?: any) => Promise<any>;
    validate?: (currentValue?: any) => Promise<any>;
    transformer?: (currentValue?: any) => Promise<any>;
    transform?: (currentValue?: any) => Promise<any>;
    translator?: (currentValue?: any, context?: any) => Promise<any>;
    translate?: (currentValue?: any, context?: any) => Promise<any>;
    schema?: any;
}

export default class Spec {
    field: string;
    actions: string[];
    data: SpecData;

    constructor(field: string) {
        this.field = field;
        this.actions = [];
        this.data = {};
        classValidation(this);
    }

    default(defaultValue: any): void {
        addAction(this, 'default');
        this.data = { ...this.data, defaultValue };
    }

    require(requireVal: boolean | (() => boolean), requireMessage?: string): void {
        addAction(this, 'require');
        this.data = { ...this.data, require: requireVal, requireMessage };
    }

    validate(validator: (currentValue?: any) => Promise<any> = () => Promise.resolve()): void {
        addAction(this, 'validate');
        this.data = { ...this.data, validator };
    }

    transform(transformer: (currentValue?: any) => Promise<any> = () => Promise.resolve()): void {
        addAction(this, 'transform');
        this.data = { ...this.data, transformer };
    }

    translate(translator: (currentValue?: any, context?: any) => Promise<any> = () => Promise.resolve()): void {
        addAction(this, 'translate');
        this.data = { ...this.data, translator };
    }

    schema(schemaObj: any): void {
        addAction(this, 'schema');
        this.data = { ...this.data, schema: schemaObj };
    }

    runValidation(context: any): Promise<void> {
        return new Validators(this.field, context, this.data, SpecFailedException).runValidation();
    }

    runRequireValidation(context: any): Promise<void> {
        return new Validators(this.field, context, this.data, SpecFailedException).runRequireValidation();
    }

    runDefault(context: any): Promise<void> {
        return new Defaults(this.field, this.data, context, SpecFailedException).runDefault();
    }

    runTransform(context: any): Promise<void> {
        return new Transformer(this.field, this.data, context, SpecFailedException).runTransform();
    }

    runTranslate(context: any): Promise<void> {
        return new Translator(this.field, this.data, context, SpecFailedException).runTranslate();
    }

    async runSchema(context: any): Promise<void> {
        const schema = this.data.schema;
        if (!schema) {
            return;
        }

        const isRoot = this.field === '$root$' || !this.field;
        const currentData = context.getData();
        const unwrap = (val: any) => (typeof val === 'function' ? val() : val);

        let targetValue: any;
        if (isRoot) {
            targetValue = {};
            for (const key of Object.keys(currentData)) {
                targetValue[key] = unwrap(currentData[key]);
            }
        } else {
            targetValue = unwrap(currentData[this.field]);
        }

        // 1. Standard Schema (~standard specification)
        if (schema && typeof schema === 'object' && schema['~standard']) {
            const standard = schema['~standard'];
            const result = await standard.validate(targetValue);
            if (result && result.issues && result.issues.length > 0) {
                const message = result.issues
                    .map((issue: any) => {
                        const pathStr = issue.path && issue.path.length ? issue.path.join('.') + ': ' : '';
                        return `${pathStr}${issue.message || 'Validation failed'}`;
                    })
                    .join('; ');
                new SpecFailedException(() => {
                    throw new Error(message);
                }, this.field);
                return;
            }
            if (result && result.value !== undefined) {
                if (isRoot && typeof result.value === 'object' && result.value !== null) {
                    for (const key of Object.keys(result.value)) {
                        context.set(key, result.value[key]);
                    }
                } else if (!isRoot) {
                    context.set(this.field, result.value);
                }
            }
            return;
        }

        // 2. safeParse (Zod, Valibot, etc.)
        if (schema && typeof schema.safeParse === 'function') {
            const result = await schema.safeParse(targetValue);
            if (!result.success) {
                const issues = result.error?.issues;
                const message =
                    issues && issues.length
                        ? issues
                              .map((i: any) => (i.path && i.path.length ? i.path.join('.') + ': ' : '') + i.message)
                              .join('; ')
                        : result.error?.message || 'Schema validation failed';
                new SpecFailedException(() => {
                    throw new Error(message);
                }, this.field);
                return;
            }
            if (result.data !== undefined) {
                if (isRoot && typeof result.data === 'object' && result.data !== null) {
                    for (const key of Object.keys(result.data)) {
                        context.set(key, result.data[key]);
                    }
                } else if (!isRoot) {
                    context.set(this.field, result.data);
                }
            }
            return;
        }

        // 3. parse() method (Zod / custom parser)
        if (schema && typeof schema.parse === 'function') {
            try {
                const parsed = await schema.parse(targetValue);
                if (parsed !== undefined) {
                    if (isRoot && typeof parsed === 'object' && parsed !== null) {
                        for (const key of Object.keys(parsed)) {
                            context.set(key, parsed[key]);
                        }
                    } else if (!isRoot) {
                        context.set(this.field, parsed);
                    }
                }
                return;
            } catch (err: any) {
                new SpecFailedException(() => {
                    throw new Error(err?.message || 'Schema validation failed');
                }, this.field);
                return;
            }
        }

        // 4. validate() method (Joi, Yup, etc.)
        if (schema && typeof schema.validate === 'function') {
            try {
                const validated = await schema.validate(targetValue);
                if (validated !== undefined) {
                    if (isRoot && typeof validated === 'object' && validated !== null) {
                        for (const key of Object.keys(validated)) {
                            context.set(key, validated[key]);
                        }
                    } else if (!isRoot) {
                        context.set(this.field, validated);
                    }
                }
                return;
            } catch (err: any) {
                new SpecFailedException(() => {
                    throw new Error(err?.message || 'Schema validation failed');
                }, this.field);
                return;
            }
        }

        // 5. Function predicate validator
        if (typeof schema === 'function') {
            const valid = await schema(targetValue);
            if (valid === false) {
                new SpecFailedException(() => {
                    throw new Error(`Validation failed for field "${this.field}"`);
                }, this.field);
            }
        }
    }
    /* c8 ignore next */
}

function addAction(spec: Spec, actionName: string): void {
    spec.actions.push(actionName);
}

function classValidation(spec: Spec): void {
    if (!spec.field) {
        throw new Error('Field name is required.');
    }
}

export { Spec };
