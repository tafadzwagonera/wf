        ---
name: coding-style
description: Coding style conventions — naming, control flow, types, documentation. Use when writing, editing, or reviewing code.
---

**Category:** Convention skill.

## Control flow
- Favor flat control flow — ternaries for expressions, switches for multiple branches, early returns to reduce nesting.
- Avoid nesting template literals and ternary operators.
- Do not use a boolean flag parameter to switch a method's internal behavior; split into separate, clearly named methods instead.
- Do not wrap a `try`/`catch` around code purely to catch an exception the same function throws itself; restructure with a guard clause or early return instead.
- Combine consecutive calls to the same method that each take multiple arguments into one call, rather than repeating the call back-to-back.
- Use `Array.includes` instead of `Array.some(x => x === value)` for plain membership checks.
- Use `.find()` when the matched element itself is needed; use `.some()` when only a boolean existence check is needed — do not use one to simulate the other.
- Always pass an explicit initial value to `Array.reduce()`.
- Use the nullish-coalescing assignment operator (`??=`) instead of `x = x ?? y`.
- Use `Array.prototype.at(-n)` instead of `arr[arr.length - n]`.
- Do not use the `void` operator to discard an expression or promise result; handle it explicitly instead.
- Give a method a `void` return type when its result is never consumed by any caller.
- Prefer arrow function expressions over `function` declarations.
- Do not use `else` after a `return`, `throw`, or `continue` — the `else` branch is unreachable.
- Use `for...of` over `Array.forEach` when the loop body needs `break`, `continue`, or `return`.
- Do not write `switch` statements without a `default` case.
- Use `Object.entries` instead of `for...in` loops when iterating over plain objects.

## Types
- Avoid unnecessary type casts, such as `as <type>`.
- Prefer precise types; `any` undermines type safety and masks bugs at call sites.

## Documentation
- Never write code comments. No inline comments, no trailing comments, no block comments inside implementation, and no commented-out code.
- Never write banner or section-divider comments, e.g. `// ===== Helpers =====`, `/* --- Types --- */`, or `// #region`.
- JSDoc blocks on exported symbols are the only permitted comment form; machine-read directives (`eslint-disable-*`, `@ts-expect-error`) are directives, not comments.
- When code needs explaining, rename it, extract it, or type it — do not annotate it.
- The ban applies to comments you author. Preexisting comments may stay: revise one when your change makes it stale or wrong, and leave the rest alone rather than stripping them.
- Keep `swagger.yml` and `README.md` aligned with Zod schemas as the source of truth.

## Testing
- Nest `describe` suites only by user outcome.
- Prefix mocks with `mock` and create matching factories, e.g., `mockEvent`, `createMockEvent`.

## Naming
- Use `SCREAMING_SNAKE_CASE` only for literals.
- Use descriptive `camelCase` names with unit suffixes where relevant, e.g., `amountInCents`, `expiryInMs`, `meanTemperatureInCelsius`, `precipitationPeakInMm`, and `ttlInSecs`.

## Regular expressions
- Group alternation and sequence sub-patterns with non-capturing groups (`(?:...)`) to make the intended operator precedence explicit.

## Imports & exports
- Re-export a symbol with `export { X } from 'module'` rather than importing it and re-exporting separately.

## Sorting
- Sort strings with a comparator that calls `.localeCompare()` — never a bare `<`/`>` comparison or an omitted comparator.

## Line length
- Keep lines at or under 120 characters; wrap long method chains, argument lists, or string concatenations across multiple lines.
