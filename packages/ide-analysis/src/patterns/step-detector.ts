import ts from 'typescript';
import type {
    GraphNode,
    UnresolvedNode,
    StepSpec,
    StepSpecRule,
    EcosystemConfig,
    HttpEcosystemConfig,
    CryptoEcosystemConfig,
    NotificationEcosystemConfig,
    AiEcosystemConfig,
} from '@siglo/ide-protocol';
import { sanitizeOriginUrl } from '@siglo/ide-protocol';
import { getSourceRange, generateDeterministicNodeId } from '../mapper';

export type DetectedStep =
    { kind: 'node'; node: GraphNode; variableName?: string } | { kind: 'unresolved'; unresolved: UnresolvedNode };

export function isEcosystemStepCallee(name: string): GraphNode['stepKind'] | null {
    switch (name) {
        case 'HttpStep':
        case 'httpStep':
            return 'http';
        case 'encryptFieldsStep':
        case 'decryptFieldsStep':
        case 'maskFieldsStep':
        case 'EncryptFieldsStep':
        case 'DecryptFieldsStep':
        case 'MaskFieldsStep':
        case 'WebhookVerifyStep':
        case 'verifyWebhookStep':
            return 'crypto';
        case 'sendNotificationStep':
        case 'sendInteractiveApprovalStep':
            return 'notification';
        case 'AiStep':
        case 'aiStep':
            return 'ai';
        case 'wait':
        case 'waitForEvent':
            return 'custom';
        case 'Step':
        case 'Func':
        case 'Chain':
        case 'defineStep':
            return 'generic';
        default:
            return null;
    }
}

export function detectStepFromExpression(
    expr: ts.Expression,
    sourceFile: ts.SourceFile,
    enclosingRange?: { start: { line: number; character: number }; end: { line: number; character: number } },
): DetectedStep | null {
    const loc = getSourceRange(sourceFile, expr);
    const declarationRange = enclosingRange || loc;

    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
        const method = expr.expression.name.text;
        const methods = [
            'timeout',
            'cache',
            'reduce',
            'withDependencies',
            'schema',
            'spec',
            'strict',
            'onBefore',
            'onSkip',
            'onAfter',
            'onFail',
            'compensate',
            'compensateWithHttp',
            'allowNetwork',
            'denyNetwork',
            'allowUnixSockets',
            'networkPolicy',
            'idempotent',
        ];
        if (methods.includes(method)) {
            const base = detectStepFromExpression(expr.expression.expression, sourceFile, enclosingRange);
            if (base?.kind === 'node') {
                if (method === 'spec' || method === 'schema') {
                    const spec = extractStepSpec(expr, method, sourceFile);
                    return {
                        ...base,
                        node: {
                            ...base.node,
                            location: loc,
                            declarationRange,
                            specs: [...(base.node.specs || []), spec],
                        },
                    };
                }
                const properties = {
                    ...base.node.properties,
                    [method]: expr.arguments.map(a => a.getText(sourceFile)).join(', ') || 'true',
                };
                const config = { ...base.node.executionConfig };
                if (method === 'timeout' && expr.arguments[0] && ts.isNumericLiteral(expr.arguments[0]))
                    config.timeoutMs = Number(expr.arguments[0].text);
                if (method === 'onFail' && expr.arguments[0] && ts.isObjectLiteralExpression(expr.arguments[0])) {
                    for (const prop of expr.arguments[0].properties) {
                        if (ts.isPropertyAssignment(prop)) {
                            const pName = prop.name.getText(sourceFile).replace(/['"]/g, '');
                            if (
                                (pName === 'maxRetries' || pName === 'retries') &&
                                ts.isNumericLiteral(prop.initializer)
                            ) {
                                config.retries = Number(prop.initializer.text);
                            }
                        }
                    }
                }
                if (method === 'compensate' || method === 'compensateWithHttp') {
                    config.hasCompensation = true;
                    if (expr.arguments[0]) {
                        properties.compensationStep = expr.arguments[0].getText(sourceFile);
                    }
                }
                return {
                    ...base,
                    node: { ...base.node, location: loc, declarationRange, properties, executionConfig: config },
                };
            }
        }
    }

    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        const name = ts.isFunctionExpression(expr) && expr.name ? expr.name.text : 'inline action';
        return {
            kind: 'node',
            node: {
                id: generateDeterministicNodeId(name, loc),
                name,
                stepKind: 'generic',
                location: loc,
                declarationRange,
            },
        };
    }

    // Pattern: Step.create(...) or ecosystem steps
    if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
        const args = expr.arguments || [];
        const callee = expr.expression;
        let stepKind: GraphNode['stepKind'] = 'generic';
        let stepName = '';
        let retries: number | undefined;
        let timeoutMs: number | undefined;
        let hasCompensation = false;

        if (
            ts.isPropertyAccessExpression(callee) &&
            ['Step', 'Func', 'Chain'].includes(callee.expression.getText(sourceFile)) &&
            callee.name.text === 'create'
        ) {
            stepKind = 'generic';
            const firstArg = args[0];
            if (firstArg) {
                if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
                    stepName = firstArg.text;
                } else if (ts.isObjectLiteralExpression(firstArg)) {
                    extractObjectConfig(firstArg, sourceFile, (name, r, t, comp) => {
                        if (name) stepName = name;
                        retries = r;
                        timeoutMs = t;
                        if (comp) hasCompensation = true;
                    });
                }
            }
            const secondArg = args[1];
            if (secondArg && ts.isObjectLiteralExpression(secondArg)) {
                extractObjectConfig(secondArg, sourceFile, (name, r, t, comp) => {
                    if (!stepName && name) stepName = name;
                    if (r !== undefined) retries = r;
                    if (t !== undefined) timeoutMs = t;
                    if (comp) hasCompensation = true;
                });
            }
        } else if (
            ts.isIdentifier(callee) ||
            (ts.isPropertyAccessExpression(callee) &&
                ['Step', 'Func', 'Chain'].includes(callee.expression.getText(sourceFile)) &&
                ['wait', 'waitForEvent'].includes(callee.name.text))
        ) {
            const calleeName = ts.isIdentifier(callee) ? callee.text : callee.name.text;
            const ecoKind = isEcosystemStepCallee(calleeName);
            if (ecoKind) {
                stepKind = ecoKind;
                const firstArg = args[0];
                if (firstArg) {
                    if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
                        stepName = firstArg.text;
                    } else if (ts.isObjectLiteralExpression(firstArg)) {
                        extractObjectConfig(firstArg, sourceFile, (name, r, t, comp) => {
                            if (name) stepName = name;
                            retries = r;
                            timeoutMs = t;
                            if (comp) hasCompensation = true;
                        });
                    }
                }
            } else {
                // Unknown or dynamic function call
                if (calleeName.endsWith('Step') || calleeName.startsWith('createStep')) {
                    stepKind = 'custom';
                    stepName = calleeName;
                } else {
                    return {
                        kind: 'unresolved',
                        unresolved: {
                            id: `unresolved_L${loc.start.line + 1}_C${loc.start.character + 1}`,
                            reason: 'external-factory',
                            expressionSnippet: expr.getText(sourceFile),
                            location: loc,
                        },
                    };
                }
            }
        } else {
            // Dynamic call (e.g. fn()(), obj[prop]())
            return {
                kind: 'unresolved',
                unresolved: {
                    id: `unresolved_L${loc.start.line + 1}_C${loc.start.character + 1}`,
                    reason: 'dynamic-call',
                    expressionSnippet: expr.getText(sourceFile),
                    location: loc,
                },
            };
        }

        const properties: Record<string, string> = { operation: callee.getText(sourceFile) };
        for (const arg of args) {
            if (ts.isObjectLiteralExpression(arg)) {
                extractObjectConfig(arg, sourceFile, (name, r, t, comp) => {
                    if (!stepName && name) stepName = name;
                    if (r !== undefined) retries = r;
                    if (t !== undefined) timeoutMs = t;
                    if (comp) hasCompensation = true;
                });
                Object.assign(properties, extractDisplayProperties(arg, sourceFile));
            }
        }
        const operation = callee.getText(sourceFile);
        if (operation === 'wait' || operation === 'Step.wait') {
            properties.duration = args[0]?.getText(sourceFile) || 'unknown';
            stepName = `wait: ${properties.duration}`;
        } else if (operation === 'waitForEvent' || operation === 'Step.waitForEvent') {
            properties.eventName = args[0]?.getText(sourceFile) || 'unknown';
            stepName = `waitForEvent: ${stepName || properties.eventName}`;
        }

        if (!stepName) {
            stepName = `step_${loc.start.line + 1}_${loc.start.character + 1}`;
        }

        const id = generateDeterministicNodeId(stepName, loc);
        const executionConfig =
            retries !== undefined || timeoutMs !== undefined || hasCompensation
                ? {
                      ...(retries !== undefined ? { retries } : {}),
                      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                      ...(hasCompensation ? { hasCompensation } : {}),
                  }
                : undefined;

        const calleeText = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : (callee as ts.Node).getText(sourceFile);
        const ecosystemConfig = isEcosystemStepCallee(calleeText)
            ? extractEcosystemConfig(calleeText, stepKind, args, sourceFile)
            : undefined;

        return {
            kind: 'node',
            node: {
                id,
                name: stepName,
                stepKind,
                location: loc,
                declarationRange,
                properties,
                ...(executionConfig ? { executionConfig } : {}),
                ...(ecosystemConfig ? { ecosystemConfig } : {}),
            },
        };
    }

    // If it's an identifier referencing an existing step
    if (ts.isIdentifier(expr)) {
        const id = generateDeterministicNodeId(expr.text, loc);
        return {
            kind: 'node',
            node: {
                id,
                name: expr.text,
                stepKind: 'generic',
                location: loc,
                declarationRange,
            },
            variableName: expr.text,
        };
    }

    // Any other expression cannot be resolved statically
    return {
        kind: 'unresolved',
        unresolved: {
            id: `unresolved_L${loc.start.line + 1}_C${loc.start.character + 1}`,
            reason: 'unsupported-syntax',
            expressionSnippet: expr.getText(sourceFile),
            location: loc,
        },
    };
}

function extractObjectConfig(
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    cb: (name?: string, retries?: number, timeoutMs?: number, hasCompensation?: boolean) => void,
) {
    let name: string | undefined;
    let retries: number | undefined;
    let timeoutMs: number | undefined;
    let hasCompensation = false;

    for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop) && prop.name) {
            const propName = prop.name.getText(sourceFile).replace(/['"]/g, '');
            if (
                propName === 'name' &&
                (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
            ) {
                name = prop.initializer.text;
            } else if ((propName === 'retries' || propName === 'maxRetries') && ts.isNumericLiteral(prop.initializer)) {
                retries = parseInt(prop.initializer.text, 10);
            } else if (propName === 'timeoutMs' && ts.isNumericLiteral(prop.initializer)) {
                timeoutMs = parseInt(prop.initializer.text, 10);
            } else if (propName === 'compensation' || propName === 'compensate') {
                hasCompensation = true;
            }
        }
    }

    cb(name, retries, timeoutMs, hasCompensation);
}

function extractStringOrSnippet(expr: ts.Expression, sourceFile: ts.SourceFile): { value: string; isDynamic: boolean } {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        return { value: expr.text, isDynamic: false };
    }
    return { value: expr.getText(sourceFile), isDynamic: true };
}

function extractNumberOrSnippet(expr: ts.Expression, sourceFile: ts.SourceFile): number | string {
    if (ts.isNumericLiteral(expr)) {
        return Number(expr.text);
    }
    return expr.getText(sourceFile);
}

function extractBooleanOrSnippet(expr: ts.Expression, sourceFile: ts.SourceFile): boolean | string {
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    return expr.getText(sourceFile);
}

export function extractEcosystemConfig(
    calleeName: string,
    stepKind: GraphNode['stepKind'],
    args: readonly ts.Expression[],
    sourceFile: ts.SourceFile,
): EcosystemConfig | undefined {
    let optionsObj: ts.ObjectLiteralExpression | undefined;
    for (const arg of args) {
        if (ts.isObjectLiteralExpression(arg)) {
            optionsObj = arg;
            break;
        }
    }

    if (stepKind === 'http') {
        const config: HttpEcosystemConfig = { kind: 'http', method: 'GET' };
        if (optionsObj) {
            for (const prop of optionsObj.properties) {
                if (ts.isPropertyAssignment(prop)) {
                    const name = prop.name.getText(sourceFile).replace(/['"]/g, '');
                    if (name === 'method') {
                        if (ts.isStringLiteral(prop.initializer)) {
                            config.method = prop.initializer.text.toUpperCase();
                        } else {
                            config.method = prop.initializer.getText(sourceFile);
                        }
                    } else if (name === 'url') {
                        const extracted = extractStringOrSnippet(prop.initializer, sourceFile);
                        if (!extracted.isDynamic) {
                            const origin = sanitizeOriginUrl(extracted.value);
                            config.url = origin || extracted.value;
                            config.isDynamicUrl = false;
                        } else {
                            config.url = extracted.value;
                            config.isDynamicUrl = true;
                        }
                    } else if (name === 'maxRetries' || name === 'retries') {
                        config.maxRetries = extractNumberOrSnippet(prop.initializer, sourceFile);
                    } else if (name === 'retryOnStatus') {
                        if (ts.isArrayLiteralExpression(prop.initializer)) {
                            config.retryOnStatus = prop.initializer.elements.map(e =>
                                ts.isNumericLiteral(e) ? Number(e.text) : e.getText(sourceFile),
                            ) as any;
                        } else {
                            config.retryOnStatus = prop.initializer.getText(sourceFile);
                        }
                    } else if (name === 'timeoutMs' || name === 'timeout') {
                        config.timeoutMs = extractNumberOrSnippet(prop.initializer, sourceFile);
                    } else if (name === 'allowNotFound') {
                        config.allowNotFound = extractBooleanOrSnippet(prop.initializer, sourceFile);
                    } else if (name === 'responseType') {
                        config.responseType = prop.initializer.getText(sourceFile).replace(/['"]/g, '');
                    }
                }
            }
        }
        return config;
    }

    if (stepKind === 'crypto') {
        let op = 'verifyWebhook';
        if (calleeName.includes('encrypt') || calleeName.includes('Encrypt')) op = 'encryptFields';
        else if (calleeName.includes('decrypt') || calleeName.includes('Decrypt')) op = 'decryptFields';
        else if (calleeName.includes('mask') || calleeName.includes('Mask')) op = 'maskFields';

        const config: CryptoEcosystemConfig = { kind: 'crypto', operation: op };
        if (optionsObj) {
            for (const prop of optionsObj.properties) {
                if (ts.isPropertyAssignment(prop)) {
                    const name = prop.name.getText(sourceFile).replace(/['"]/g, '');
                    if (name === 'provider') {
                        if (ts.isStringLiteral(prop.initializer)) config.provider = prop.initializer.text;
                        else config.provider = prop.initializer.getText(sourceFile);
                    } else if (name === 'algorithm') {
                        if (ts.isStringLiteral(prop.initializer)) config.algorithm = prop.initializer.text;
                        else config.algorithm = prop.initializer.getText(sourceFile);
                    } else if (name === 'toleranceSeconds') {
                        config.toleranceSeconds = extractNumberOrSnippet(prop.initializer, sourceFile);
                    } else if (name === 'fields') {
                        if (ts.isArrayLiteralExpression(prop.initializer)) {
                            config.fields = prop.initializer.elements.map(e =>
                                ts.isStringLiteral(e) ? e.text : e.getText(sourceFile),
                            );
                        } else {
                            config.fields = prop.initializer.getText(sourceFile);
                        }
                    }
                }
            }
        }
        return config;
    }

    if (stepKind === 'notification') {
        const isApproval = calleeName.toLowerCase().includes('approval');
        const config: NotificationEcosystemConfig = { kind: 'notification', isApproval };
        if (optionsObj) {
            for (const prop of optionsObj.properties) {
                if (ts.isPropertyAssignment(prop)) {
                    const name = prop.name.getText(sourceFile).replace(/['"]/g, '');
                    if (name === 'channel') {
                        if (ts.isStringLiteral(prop.initializer)) config.channel = prop.initializer.text;
                        else config.channel = prop.initializer.getText(sourceFile);
                    } else if (name === 'subject') {
                        if (ts.isStringLiteral(prop.initializer)) config.subject = prop.initializer.text;
                        else config.subject = prop.initializer.getText(sourceFile);
                    } else if (name === 'template') {
                        if (ts.isStringLiteral(prop.initializer)) config.template = prop.initializer.text;
                        else config.template = prop.initializer.getText(sourceFile);
                    } else if (name === 'approvalExpiresIn' || name === 'approvalExpiresAt' || name === 'timeout') {
                        config.approvalExpiresIn = extractStringOrSnippet(prop.initializer, sourceFile).value;
                    } else if (name === 'approval') {
                        if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) config.isApproval = true;
                    }
                }
            }
        }
        return config;
    }

    if (stepKind === 'ai') {
        const config: AiEcosystemConfig = { kind: 'ai' };
        if (optionsObj) {
            for (const prop of optionsObj.properties) {
                if (ts.isPropertyAssignment(prop)) {
                    const name = prop.name.getText(sourceFile).replace(/['"]/g, '');
                    if (name === 'provider') {
                        if (ts.isStringLiteral(prop.initializer)) config.provider = prop.initializer.text;
                        else config.provider = prop.initializer.getText(sourceFile);
                    } else if (name === 'model') {
                        if (ts.isStringLiteral(prop.initializer)) {
                            config.model = prop.initializer.text;
                        } else if (ts.isObjectLiteralExpression(prop.initializer)) {
                            for (const modelProp of prop.initializer.properties) {
                                if (ts.isPropertyAssignment(modelProp)) {
                                    const mKey = modelProp.name.getText(sourceFile).replace(/['"]/g, '');
                                    if (mKey === 'provider') {
                                        config.provider = ts.isStringLiteral(modelProp.initializer)
                                            ? modelProp.initializer.text
                                            : modelProp.initializer.getText(sourceFile);
                                    } else if (mKey === 'model') {
                                        config.model = ts.isStringLiteral(modelProp.initializer)
                                            ? modelProp.initializer.text
                                            : modelProp.initializer.getText(sourceFile);
                                    }
                                }
                            }
                        } else {
                            config.model = prop.initializer.getText(sourceFile);
                        }
                    } else if (name === 'maxRepairAttempts') {
                        config.maxRepairAttempts = extractNumberOrSnippet(prop.initializer, sourceFile);
                    } else if (name === 'temperature') {
                        config.temperature = extractNumberOrSnippet(prop.initializer, sourceFile);
                    } else if (name === 'maxTokens') {
                        config.maxTokens = extractNumberOrSnippet(prop.initializer, sourceFile);
                    } else if (name === 'fallbackModels') {
                        if (ts.isArrayLiteralExpression(prop.initializer)) {
                            config.fallbackModels = prop.initializer.elements.map(e => e.getText(sourceFile));
                        } else {
                            config.fallbackModels = prop.initializer.getText(sourceFile);
                        }
                    }
                }
            }
        }
        return config;
    }

    return undefined;
}

// Deliberately show operational options only; credentials and request payloads
// are not inspector properties. Expressions are displayed without evaluation.
export function extractDisplayProperties(
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
): Record<string, string> {
    const keys = new Set([
        'method',
        'responseType',
        'allowNotFound',
        'maxRetries',
        'timeoutMs',
        'timeout',
        'channel',
        'provider',
        'model',
        'fields',
        'concurrency',
        'stopOnError',
        'preserveOrder',
        'mergeStrategy',
        'mode',
        'collision',
        'correlationKey',
    ]);
    const result: Record<string, string> = {};
    for (const prop of obj.properties)
        if (ts.isPropertyAssignment(prop)) {
            const key = prop.name.getText(sourceFile).replace(/['"]/g, '');
            if (keys.has(key)) result[key] = prop.initializer.getText(sourceFile);
        }
    return result;
}

function extractStepSpec(call: ts.CallExpression, method: string, sourceFile: ts.SourceFile): StepSpec {
    const args = call.arguments;
    const fieldArg = args[0];
    const fieldLiteral = fieldArg && (ts.isStringLiteral(fieldArg) || ts.isNoSubstitutionTemplateLiteral(fieldArg));
    const field =
        method === 'schema' || (args.length < 2 && !fieldLiteral)
            ? '$root$'
            : fieldLiteral
              ? fieldArg.text
              : fieldArg?.getText(sourceFile) || '$root$';
    const config = method === 'schema' || (args.length < 2 && !fieldLiteral) ? args[0] : args[1];
    const rule = (kind: StepSpecRule['kind'], value: ts.Expression): StepSpecRule => {
        const literal = ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value);
        const expression =
            !literal &&
            !ts.isNumericLiteral(value) &&
            ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(value.kind);
        let description: string | undefined;
        function visit(node: ts.Node) {
            if (
                ts.isThrowStatement(node) &&
                node.expression &&
                ts.isNewExpression(node.expression) &&
                node.expression.expression.getText(sourceFile) === 'Error'
            ) {
                const message = node.expression.arguments?.[0];
                if (!description && message && ts.isStringLiteral(message)) description = message.text;
            }
            ts.forEachChild(node, visit);
        }
        visit(value);
        return {
            kind,
            value: literal ? value.text : value.getText(sourceFile),
            expression,
            ...(description ? { description } : {}),
        };
    };
    if (!config) return { field, rules: [] };
    if (method === 'schema' || field === '$root$') return { field, rules: [rule('schema', config)] };
    if (!ts.isObjectLiteralExpression(config)) return { field, rules: [rule('options', config)] };
    // Match runtime alias precedence and retain each chained spec invocation.
    const options = new Map<string, ts.Expression>();
    for (const prop of config.properties) {
        if (ts.isPropertyAssignment(prop))
            options.set(prop.name.getText(sourceFile).replace(/['"]/g, ''), prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop)) options.set(prop.name.text, prop.name);
    }
    const rules: StepSpecRule[] = [];
    const aliases: [StepSpecRule['kind'], string[]][] = [
        ['default', ['default', 'defaultValue']],
        ['required', ['require']],
        ['message', ['requireMessage']],
        ['validate', ['validate', 'validator']],
        ['transform', ['transform', 'transformer']],
        ['translate', ['translate', 'translator']],
        ['schema', ['schema']],
    ];
    for (const [kind, names] of aliases) {
        const value = names.map(name => options.get(name)).find(value => value !== undefined);
        if (value) rules.push(rule(kind, value));
    }
    if (config.properties.some(p => ts.isSpreadAssignment(p))) rules.push(rule('options', config));
    // Schema objects passed directly to the field overload are schema inputs.
    if (options.has('parse') || options.has('safeParse') || options.has('~standard'))
        return { field, rules: [rule('schema', config)] };
    return { field, rules };
}
