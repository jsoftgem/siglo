import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';

export function parseLiteralToJSON(ast: ValueNode, variables?: Record<string, unknown> | null): unknown {
    switch (ast.kind) {
        case Kind.STRING:
            return ast.value;
        case Kind.BOOLEAN:
            return ast.value;
        case Kind.INT:
            return parseInt(ast.value, 10);
        case Kind.FLOAT:
            return parseFloat(ast.value);
        case Kind.OBJECT:
            return Object.fromEntries(ast.fields.map(f => [f.name.value, parseLiteralToJSON(f.value, variables)]));
        case Kind.LIST:
            return ast.values.map(item => parseLiteralToJSON(item, variables));
        case Kind.NULL:
            return null;
        case Kind.VARIABLE:
            return variables ? variables[ast.name.value] : undefined;
        case Kind.ENUM:
            return ast.value;
        default: {
            const _exhaustive: never = ast;
            void _exhaustive;
            return undefined;
        }
    }
}

export const GraphQLJSON = new GraphQLScalarType({
    name: 'JSON',
    description: 'Arbitrary JSON value',
    serialize(value) {
        return value;
    },
    parseValue(value) {
        return value;
    },
    parseLiteral(ast, variables) {
        return parseLiteralToJSON(ast, variables ?? undefined);
    },
});

export const GraphQLDateTime = new GraphQLScalarType({
    name: 'DateTime',
    description: 'ISO 8601 compliant DateTime string',
    serialize(value) {
        if (value instanceof Date) {
            if (isNaN(value.getTime())) throw new TypeError('DateTime cannot represent an invalid Date');
            return value.toISOString();
        }
        if (typeof value === 'string' || typeof value === 'number') {
            const d = new Date(value);
            if (isNaN(d.getTime())) throw new TypeError(`DateTime cannot represent an invalid Date: ${value}`);
            return d.toISOString();
        }
        throw new TypeError(`DateTime cannot represent non-date value: ${value}`);
    },
    parseValue(value) {
        if (typeof value === 'string' || typeof value === 'number') {
            const d = new Date(value);
            if (isNaN(d.getTime())) throw new TypeError(`DateTime cannot represent an invalid Date: ${value}`);
            return d;
        }
        if (value instanceof Date) {
            if (isNaN(value.getTime())) throw new TypeError('DateTime cannot represent an invalid Date');
            return value;
        }
        throw new TypeError(`DateTime cannot represent non-date value: ${value}`);
    },
    parseLiteral(ast, variables) {
        if (ast.kind === Kind.VARIABLE && variables) {
            const val = variables[ast.name.value];
            return typeof val === 'string' || typeof val === 'number' || val instanceof Date ? new Date(val) : null;
        }
        if (ast.kind === Kind.STRING || ast.kind === Kind.INT) {
            const d = new Date(ast.kind === Kind.INT ? parseInt(ast.value, 10) : ast.value);
            if (isNaN(d.getTime())) throw new TypeError(`DateTime cannot represent an invalid Date: ${ast.value}`);
            return d;
        }
        throw new TypeError(`DateTime cannot represent non-string/int value kind: ${ast.kind}`);
    },
});
