---
name: typescript-code-review
description: Perform thorough TypeScript code reviews focused on runtime safety, type accuracy, null handling, exhaustive union checks, system boundary validation, and clean API/React contracts. Use when reviewing TypeScript pull requests, diffs, modules, React components, or backend endpoints, or when the user asks for a TypeScript code review or PR audit.
---
# TypeScript Code Review

Review TypeScript code by verifying that declared types accurately represent runtime data and prevent invalid states, catching issues that pass static compilation.

## When to Use

- Reviewing TypeScript pull requests, diffs, or specific `.ts` / `.tsx` files
- Auditing TypeScript type safety, runtime boundaries, or compiler configurations
- Evaluating React component prop contracts or backend API/webhook input handling
- Checking test mocks and fixtures for realistic type compliance

## Review Workflow

Focus review depth on where runtime risk sits in the change. Work through the following areas in order:

### 1. Compiler Configuration & Automated Checks

Verify project-level guarantees before reviewing individual files:

- Check `tsconfig.json` for `"strict": true` (enabling `noImplicitAny` and `strictNullChecks`).
- In monorepos or multi-package setups, verify child `tsconfig.json` files do not weaken inherited strictness settings.
- Confirm automated checks (`tsc --noEmit`, ESLint, Prettier) are passing or configured in CI so manual review focuses on logic and runtime guarantees.

### 2. Type Safety (`any`, `unknown`, and Assertions)

Challenge every escape hatch that bypasses compiler verification:

- **Flag unjustified `any`**: Ensure `any` is not used merely to silence compiler errors. Require a concrete justification, isolation so it does not leak across module boundaries, or replacement with `unknown` or a specific type.
- **Prefer `unknown` for unverified data**: External inputs (API responses, webhooks, file reads, parsed JSON, caught errors) must enter as `unknown` and be narrowed via type guards or runtime schemas before property access.
- **Scrutinize `as` assertions**: Type assertions perform zero runtime checks. Flag `as SomeType` on external or unverified data and recommend runtime schema validation (such as Zod) or custom type guard functions (`value is SomeType`).
- **Prefer `satisfies` over `as` for internal literals**: When verifying that a locally constructed object conforms to a type without widening or losing inferred literal keys, recommend `satisfies Type` instead of `as Type`.

### 3. Nullability, Falsy Values, and Exhaustiveness

Ensure edge-case values and state transitions are handled explicitly:

- **Distinguish missing values from valid falsy values**: Flag `||` fallbacks where `0`, `false`, or `""` are valid inputs (for example, `retries || 3`). Recommend nullish coalescing (`??`) and optional chaining (`?.`) so fallbacks trigger only on `null` or `undefined`.
- **Enforce exhaustive union handling**: Check `switch` statements and `if`/`else` chains branching on discriminated or string literal unions. Require a `default` branch assigning the discriminant to `never` (`const _exhaustive: never = value`) so adding new union members produces a compile-time error.

### 4. API & Component Contracts

Evaluate whether public signatures prevent misuse rather than just compiling:

- **Public functions and shared modules**: Require explicit return types on exported functions and hooks so internal refactors cannot accidentally alter external contracts. Flag vague type names (`Data`, `Info`, `Item`, `Payload`) in favor of domain-specific names.
- **React component props**: Flag multiple mutually exclusive boolean flags (for example, `isPrimary`, `isDestructive`, `isIconOnly`) and recommend discriminated unions or a single `variant` union prop. Flag callbacks typed as generic `Function`, event handlers using `any`, and optional props that should be required.

### 5. System Boundaries & Error Handling

Verify runtime validation wherever untrusted data crosses into typed application code:

- **Backend inputs and webhooks**: Confirm request bodies, query params, headers, and webhook payloads are parsed and validated at the boundary before reaching business logic.
- **Environment variables**: Check that `process.env` values are validated and narrowed at startup rather than assumed to be defined strings.
- **Caught errors**: In `catch (err)` blocks, treat `err` as `unknown` and narrow with `instanceof Error` or a helper before reading `.message` or `.stack`.

### 6. Tests, Mocks, and Fixtures

Ensure test setups do not mask contract drift:

- Flag test fixtures or mocks cast with `as User` or `as any` that omit required properties, as they allow tests to pass even when production types break.
- Recommend factory helpers typed with `satisfies` or complete domain objects.

## Output Format

Structure code review feedback clearly by severity:

1. **Blocking Issues (Runtime & Contract Risks)**: Unvalidated external casts, unsafe `any` leaks, non-exhaustive unions, or broken falsy/null logic.
2. **Improvements (Type Modeling & Maintainability)**: Opportunities to replace `as` with `satisfies`, tighten React prop unions, add explicit return types, or improve domain naming.
3. **Summary Checklist**: A concise pass/fail overview of the reviewed areas with actionable fixes and code snippets.

## Gotchas

- **Do not treat compilation as correctness**: Code with zero `tsc` errors can still crash at runtime if `as` assertions or `any` mask real payload shapes.
- **Do not ban `any` dogmatically**: Allow isolated `any` when wrapping untyped third-party libraries or during incremental JS-to-TS migrations, provided it is contained behind a typed boundary.
- **Respect review scope**: Focus deeply on high-risk boundaries (auth, payments, external APIs, shared libraries) rather than nitpicking minor internal helpers.
