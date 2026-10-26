"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Spec = void 0;
const defaults_1 = require("./defaults");
const SpecFailedException_1 = require("./SpecFailedException");
const transformer_1 = require("./transformer");
const translator_1 = require("./translator");
const validators_1 = require("./validators");
class Spec {
    field;
    actions;
    data;
    constructor(field) {
        this.field = field;
        this.actions = [];
        this.data = {};
        classValidation(this);
    }
    default(defaultValue) {
        addAction(this, 'default');
        this.data = { ...this.data, defaultValue };
    }
    require(requireVal, requireMessage) {
        addAction(this, 'require');
        this.data = { ...this.data, require: requireVal, requireMessage };
    }
    validate(validator = () => Promise.resolve()) {
        addAction(this, 'validate');
        this.data = { ...this.data, validator };
    }
    transform(transformer = () => Promise.resolve()) {
        addAction(this, 'transform');
        this.data = { ...this.data, transformer };
    }
    translate(translator = () => Promise.resolve()) {
        addAction(this, 'translate');
        this.data = { ...this.data, translator };
    }
    schema(schemaObj) {
        addAction(this, 'schema');
        this.data = { ...this.data, schema: schemaObj };
    }
    runValidation(context) {
        return new validators_1.Validators(this.field, context, this.data, SpecFailedException_1.SpecFailedException).runValidation();
    }
    runRequireValidation(context) {
        return new validators_1.Validators(this.field, context, this.data, SpecFailedException_1.SpecFailedException).runRequireValidation();
    }
    runDefault(context) {
        return new defaults_1.Defaults(this.field, this.data, context, SpecFailedException_1.SpecFailedException).runDefault();
    }
    runTransform(context) {
        return new transformer_1.Transformer(this.field, this.data, context, SpecFailedException_1.SpecFailedException).runTransform();
    }
    runTranslate(context) {
        return new translator_1.Translator(this.field, this.data, context, SpecFailedException_1.SpecFailedException).runTranslate();
    }
    async runSchema(context) {
        const schema = this.data.schema;
        if (!schema) {
            return;
        }
        const isRoot = this.field === '$root$' || !this.field;
        const currentData = context.getData();
        const unwrap = (val) => (typeof val === 'function' ? val() : val);
        let targetValue;
        if (isRoot) {
            targetValue = {};
            for (const key of Object.keys(currentData)) {
                targetValue[key] = unwrap(currentData[key]);
            }
        }
        else {
            targetValue = unwrap(currentData[this.field]);
        }
        // 1. Standard Schema (~standard specification)
        if (schema && typeof schema === 'object' && schema['~standard']) {
            const standard = schema['~standard'];
            const result = await standard.validate(targetValue);
            if (result && result.issues && result.issues.length > 0) {
                const message = result.issues
                    .map((issue) => {
                    const pathStr = issue.path && issue.path.length ? issue.path.join('.') + ': ' : '';
                    return `${pathStr}${issue.message || 'Validation failed'}`;
                })
                    .join('; ');
                new SpecFailedException_1.SpecFailedException(() => {
                    throw new Error(message);
                }, this.field);
                return;
            }
            if (result && result.value !== undefined) {
                if (isRoot && typeof result.value === 'object' && result.value !== null) {
                    for (const key of Object.keys(result.value)) {
                        context.set(key, result.value[key]);
                    }
                }
                else if (!isRoot) {
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
                const message = issues && issues.length
                    ? issues.map((i) => (i.path && i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; ')
                    : (result.error?.message || 'Schema validation failed');
                new SpecFailedException_1.SpecFailedException(() => {
                    throw new Error(message);
                }, this.field);
                return;
            }
            if (result.data !== undefined) {
                if (isRoot && typeof result.data === 'object' && result.data !== null) {
                    for (const key of Object.keys(result.data)) {
                        context.set(key, result.data[key]);
                    }
                }
                else if (!isRoot) {
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
                    }
                    else if (!isRoot) {
                        context.set(this.field, parsed);
                    }
                }
                return;
            }
            catch (err) {
                new SpecFailedException_1.SpecFailedException(() => {
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
                    }
                    else if (!isRoot) {
                        context.set(this.field, validated);
                    }
                }
                return;
            }
            catch (err) {
                new SpecFailedException_1.SpecFailedException(() => {
                    throw new Error(err?.message || 'Schema validation failed');
                }, this.field);
                return;
            }
        }
        // 5. Function predicate validator
        if (typeof schema === 'function') {
            const valid = await schema(targetValue);
            if (valid === false) {
                new SpecFailedException_1.SpecFailedException(() => {
                    throw new Error(`Validation failed for field "${this.field}"`);
                }, this.field);
            }
        }
    }
}
exports.default = Spec;
exports.Spec = Spec;
function addAction(spec, actionName) {
    spec.actions.push(actionName);
}
function classValidation(spec) {
    if (!spec.field) {
        throw new Error('Field name is required.');
    }
}
//# sourceMappingURL=index.js.map