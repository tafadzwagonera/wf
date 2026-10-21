---
name: coding-style
description: Team coding style — naming, control flow, types, documentation. Use when writing, editing, or reviewing code.
---

**Category:** Convention skill.

Write code that reads like the surrounding code. These are the team's opinions on the points where Claude's defaults differ; where the file you are editing already follows a clear local pattern, match it.

## Control flow
Goal: a reader follows the happy path top to bottom without tracking nested branches.

- Reach for guard clauses and early returns first, then ternaries for expressions and `switch` (always with a `default`) for three or more branches. This holds for code snippets in plans too.
- Put the positive case first. Leave assertions as they are.
  ```ts
  // before                      // after
  if (!x) { a } else { b }       if (x) { b } else { a }
  !x ? a : b                     x ? b : a
  ```
- When a branch carries its own logic, extract it into a small single-purpose helper. For a first-call versus already-initialised split, use one ternary and delegate the per-item work to a flat helper.
- Split a method that takes a boolean flag into two clearly named methods.
- Keep ternaries and template literals un-nested.
- Do not wrap `try`/`catch` around an exception the same function throws; use a guard clause.
- Prefer arrow functions over `function` declarations.
- Handle promises and expression results explicitly rather than discarding them with `void`. Give a method a `void` return type when no caller uses its result.

## Arrays, objects, and operators
Goal: pick the construct that states the intent.

- Membership check: `arr.includes(v)`, not `arr.some(x => x === v)`.
- Need the element: `.find()`. Need a boolean: `.some()`.
- `reduce` always takes an initial value.
- `for...of` when the body needs `break`, `continue`, or `return`; `forEach` otherwise.
- `Object.entries` for plain-object iteration, not `for...in`.
- `arr.at(-n)`, not `arr[arr.length - n]`.
- `x ??= y`, not `x = x ?? y`.
- `str.replaceAll(pattern, repl)` when replacing every occurrence, not `str.replace()` with a `g`-flagged regex.
- `String.raw` for strings that would otherwise escape backslashes: `` String.raw`C:\temp\file` ``, not `'C:\\temp\\file'`.
- Merge back-to-back calls to the same multi-argument method into one call.

## Types
- Make types precise, because `any` and unnecessary `as <type>` casts hide bugs at call sites.

## Documentation
Goal: code explains itself through names, structure, and types.

- Write no new comments of any form: inline, trailing, block, commented-out code, or section dividers such as `// ===== Helpers =====` and `// #region`. Rename, extract, or type the code instead.
- Preserve existing comments. Revise one only when your change makes it stale or wrong.
- Use JSDoc only on exported symbols. Directives such as `eslint-disable-*` and `@ts-expect-error` are not comments and stay allowed.
- Treat Zod schemas as the source of truth and keep `swagger.yml` and `README.md` aligned with them.

## Testing
- Nest `describe` suites by user outcome only.
- Prefix mocks with `mock` and pair each with a factory: `mockEvent`, `createMockEvent`.

## Naming
Goal: casing tells the reader how a constant behaves.

- Module-scoped constants holding a fixed primitive use `SCREAMING_SNAKE_CASE`, exported or not. This covers numbers, strings (literal, template, `path.join(...)`, or derived from other constants), booleans, and regex patterns.
- Module-scoped structured constants (arrays, objects, Sets, Maps, lookup tables, arrow functions) use `camelCase`. `as const` does not change this.
- Function-scoped constants always use `camelCase`, even for fixed primitives.
- Add unit suffixes to names where a unit applies: `amountInCents`, `expiryInMs`, `ttlInSecs`, `meanTemperatureInCelsius`, `precipitationPeakInMm`.

## Regular expressions
Goal: a reader can verify a pattern at a glance.

- Keep each pattern to 20 characters or fewer. If it needs more, split it into named parts or use string methods.
- Wrap alternation and sequence sub-patterns in non-capturing groups, `(?:...)`, so precedence is explicit.

## Imports, sorting, and layout
- Re-export with `export { X } from 'module'`, not import-then-export.
- Sort strings with `.localeCompare()`, never a bare `<`/`>` or an omitted comparator.
- Keep lines at or under 120 characters, wrapping long chains, argument lists, and concatenations.
