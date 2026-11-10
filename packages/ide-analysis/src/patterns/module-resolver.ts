import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export interface ImportBinding {
    specifier: string;
    importedName: string;
    isNamespace?: boolean;
}

export type ExportTarget =
    | { kind: 'declaration'; node: ts.FunctionDeclaration | ts.VariableDeclaration }
    | { kind: 'expression'; expr: ts.Expression }
    | { kind: 'local'; localName: string }
    | { kind: 'reexport'; specifier: string; importedName: string };

export interface ModuleMetadata {
    imports: Map<string, ImportBinding>;
    exports: Map<string, ExportTarget>;
    starExports: string[];
    declarations: Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>;
}

const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_TO_TS_EXTENSIONS: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.js'],
    '.jsx': ['.tsx', '.ts', '.jsx'],
    '.mjs': ['.mts', '.ts', '.mjs'],
    '.cjs': ['.cts', '.ts', '.cjs'],
};

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
    return Boolean(ts.getModifiers(node)?.some(m => m.kind === kind));
}

export function resolveRelativeImportPath(fromFilePath: string, specifier: string): string | null {
    if (!fromFilePath || (!specifier.startsWith('./') && !specifier.startsWith('../'))) {
        return null;
    }

    const base = path.resolve(path.dirname(fromFilePath), specifier);
    const ext = path.extname(base);
    const candidates: string[] = [];

    if (TS_EXTENSIONS.includes(ext)) {
        candidates.push(base);
    } else if (ext in JS_TO_TS_EXTENSIONS) {
        const stem = base.slice(0, -ext.length);
        for (const mapped of JS_TO_TS_EXTENSIONS[ext]) {
            candidates.push(`${stem}${mapped}`);
        }
    } else {
        for (const tsExt of [...TS_EXTENSIONS, '.js', '.jsx']) {
            candidates.push(`${base}${tsExt}`);
        }
        for (const idxExt of [...TS_EXTENSIONS, '.js']) {
            candidates.push(path.join(base, `index${idxExt}`));
        }
    }

    for (const candidate of candidates) {
        try {
            const stat = fs.statSync(candidate);
            if (stat.isFile() && stat.size <= MAX_IMPORT_FILE_BYTES) {
                return candidate;
            }
        } catch {
            // Try next candidate
        }
    }

    return null;
}

export function collectModuleMetadata(sourceFile: ts.SourceFile): ModuleMetadata {
    const imports = new Map<string, ImportBinding>();
    const exports = new Map<string, ExportTarget>();
    const starExports: string[] = [];
    const declarations = new Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>();

    for (const stmt of sourceFile.statements) {
        if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
            const clause = stmt.importClause;
            if (!clause || clause.isTypeOnly) continue;
            const specifier = stmt.moduleSpecifier.text;

            if (clause.name) {
                imports.set(clause.name.text, { specifier, importedName: 'default' });
            }
            if (clause.namedBindings) {
                if (ts.isNamespaceImport(clause.namedBindings)) {
                    imports.set(clause.namedBindings.name.text, {
                        specifier,
                        importedName: '*',
                        isNamespace: true,
                    });
                } else if (ts.isNamedImports(clause.namedBindings)) {
                    for (const el of clause.namedBindings.elements) {
                        if (el.isTypeOnly) continue;
                        const importedName = el.propertyName ? el.propertyName.text : el.name.text;
                        imports.set(el.name.text, { specifier, importedName });
                    }
                }
            }
        } else if (ts.isFunctionDeclaration(stmt)) {
            if (stmt.name) {
                declarations.set(stmt.name.text, stmt);
            }
            if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
                exports.set('default', { kind: 'declaration', node: stmt });
            } else if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword) && stmt.name) {
                exports.set(stmt.name.text, { kind: 'declaration', node: stmt });
            }
        } else if (ts.isVariableStatement(stmt)) {
            const isExported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) {
                    declarations.set(decl.name.text, decl);
                    if (isExported) {
                        exports.set(decl.name.text, { kind: 'declaration', node: decl });
                    }
                }
                if (
                    decl.initializer &&
                    ts.isCallExpression(decl.initializer) &&
                    ts.isIdentifier(decl.initializer.expression) &&
                    decl.initializer.expression.text === 'require' &&
                    decl.initializer.arguments[0] &&
                    ts.isStringLiteral(decl.initializer.arguments[0])
                ) {
                    const specifier = decl.initializer.arguments[0].text;
                    if (ts.isIdentifier(decl.name)) {
                        imports.set(decl.name.text, { specifier, importedName: '*', isNamespace: true });
                    } else if (ts.isObjectBindingPattern(decl.name)) {
                        for (const el of decl.name.elements) {
                            if (ts.isIdentifier(el.name)) {
                                const importedName =
                                    el.propertyName && ts.isIdentifier(el.propertyName)
                                        ? el.propertyName.text
                                        : el.name.text;
                                imports.set(el.name.text, { specifier, importedName });
                            }
                        }
                    }
                }
            }
        } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
            if (ts.isIdentifier(stmt.expression)) {
                exports.set('default', { kind: 'local', localName: stmt.expression.text });
            } else {
                exports.set('default', { kind: 'expression', expr: stmt.expression });
            }
        } else if (ts.isExportDeclaration(stmt)) {
            const specifier =
                stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
                    ? stmt.moduleSpecifier.text
                    : undefined;
            if (!stmt.exportClause && specifier) {
                starExports.push(specifier);
            } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
                for (const el of stmt.exportClause.elements) {
                    if (el.isTypeOnly) continue;
                    const exportedName = el.name.text;
                    const sourceName = el.propertyName ? el.propertyName.text : el.name.text;
                    if (specifier) {
                        exports.set(exportedName, { kind: 'reexport', specifier, importedName: sourceName });
                    } else {
                        exports.set(exportedName, { kind: 'local', localName: sourceName });
                    }
                }
            }
        }
    }

    return { imports, exports, starExports, declarations };
}

export function findLexicalDeclaration(
    name: string,
    usageNode: ts.Node,
    topLevelDeclarations: Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>,
): ts.FunctionDeclaration | ts.VariableDeclaration | undefined {
    let curr: ts.Node | undefined = usageNode.parent;
    while (curr) {
        if (ts.isBlock(curr) || ts.isSourceFile(curr)) {
            for (const stmt of curr.statements) {
                if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
                    return stmt;
                }
                if (ts.isVariableStatement(stmt)) {
                    for (const decl of stmt.declarationList.declarations) {
                        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
                            return decl;
                        }
                    }
                }
            }
        }
        curr = curr.parent;
    }
    return topLevelDeclarations.get(name);
}

export function extractFunctionReturnExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
        return [fn.body];
    }
    if (!fn.body || !ts.isBlock(fn.body)) {
        return [];
    }

    const returns: ts.Expression[] = [];
    function visit(node: ts.Node) {
        if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
            return;
        }
        if (ts.isReturnStatement(node) && node.expression) {
            returns.push(node.expression);
        }
        ts.forEachChild(node, visit);
    }
    ts.forEachChild(fn.body, visit);
    return returns;
}
