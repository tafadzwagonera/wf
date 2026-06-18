<!--
  Sync Impact Report
  ==================
  Version change: (none) → 1.0.0

  This is the initial ratification of the wf project constitution.

  Added sections:
  - Core Principles (8 principles: I–VIII)
  - Project Conventions
  - Development Workflow
  - Governance

  Modified principles: N/A (initial ratification)
  Removed sections: N/A (initial ratification)

  Templates reviewed:
  - .specify/templates/plan-template.md     ✅ Constitution Check section present;
                                               gates will be derived from this constitution
  - .specify/templates/spec-template.md     ✅ User-story independence and P1 conventional-commits
                                               conventions already embedded
  - .specify/templates/tasks-template.md    ✅ Phase structure aligns with P1 prerequisite;
                                               test tasks correctly marked OPTIONAL per spec
  - .specify/templates/agent-file-template.md ✅ Generic placeholders only; no conflicting agent
                                               names hardcoded
  - .specify/templates/commands/            ✅ No files found — nothing to update

  Deferred TODOs: none
-->

# wf Constitution

## Core Principles

### I. Autonomy-First

Every `wf` command MUST be fully operable without human interaction by default.
Interactive prompts are PROHIBITED unless the caller explicitly passes `--interactive`.
This ensures commands are composable in CI/CD pipelines, scripts, and non-TTY
environments without hanging or requiring user input.

**Non-negotiable rules:**
- All required inputs MUST be satisfiable via flags or environment variables.
- Prompts MUST be gated behind an `--interactive` flag.
- `--dry-run` MUST be available on any command that mutates state.

### II. Platform-Agnostic AI

AI provider references MUST be abstracted behind `AiService`. No command,
agent, or module may import or hard-code a specific provider SDK
(e.g., `@anthropic-ai/sdk`, `@google/generative-ai`) directly; all calls go
through `AiService`. The active provider is controlled by the `AI_PROVIDER`
environment variable.

**Non-negotiable rules:**
- `AiService` is the single point of AI interaction across the codebase.
- Provider-specific logic belongs in the AI integration module only.
- Adding a new provider MUST NOT require changes outside the AI module.

### III. Conventional Commits (P1 Prerequisite)

Conventional commit format (`<type>(<scope>): <description>`) is REQUIRED on
every commit. This is a P1 gate: no feature branch may be considered complete
until all commits on it conform. The `wf issue:commit` command enforces this
by default; manual bypasses are PROHIBITED in automation contexts.

**Non-negotiable rules:**
- Permitted types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`.
- Scope is optional but RECOMMENDED for clarity.
- Subject line MUST NOT exceed 72 characters.

### IV. NestJS Module Boundaries

Every new external integration (platform, service, or AI provider) MUST live
in its own NestJS module under `src/integrations/`. Cross-module coupling
MUST go through published module exports — never through direct service imports
across module boundaries.

**Non-negotiable rules:**
- One integration = one NestJS module.
- Shared types and DTOs belong in `src/common/`.
- Circular module dependencies are PROHIBITED.

### V. Artifact Isolation

All runtime state, logs, and generated artifacts MUST be written under `.wf/`.
No command may write files to the project root or any path outside `.wf/`
except where the caller explicitly specifies an output path via a flag.

**Non-negotiable rules:**
- Default runtime directories: `.wf/state/`, `.wf/logs/`.
- Platform artifacts (fetched tickets, plans, reviews) write to
  `./<platform>/` relative to the caller's working directory.
- `.wf/**` MUST be present in `.gitignore` of any consuming project.

### VI. Uniform CLI Surface

Every command MUST present its options in alphabetical order and include at
least one color-coded usage example in its help output. This makes the CLI
predictable and learnable regardless of which command the user encounters
first.

**Non-negotiable rules:**
- Options MUST be sorted alphabetically (short flag before long flag).
- Each command MUST include `--dry-run` and at least one chalk-colored example.
- Help text MUST follow the chalk color convention documented in project memory
  (`feedback_chalk_color_convention.md`).

### VII. Build Gate

`nest build` MUST pass with zero errors before any feature is declared
complete. No feature branch may be merged and no manual test may be treated
as valid while the TypeScript build is broken. Compilation errors are blockers,
not warnings.

**Non-negotiable rules:**
- Run `yarn build` as the final pre-merge step.
- A passing build is a hard prerequisite for the test gate.
- Build output in `dist/` MUST NOT be committed to source control.

### VIII. Test Coverage

Every new NestJS command or agent MUST ship with a co-located `.spec.ts` unit
test file. Tests MUST be run and pass before a feature is considered complete.
Mocks for external dependencies MUST use the `mock` prefix (e.g., `mockEvent`,
`mockTicket`).

**Non-negotiable rules:**
- New `*.command.ts` → requires `*.command.spec.ts` in the same directory.
- New `*-agent.ts` / `*.agent.ts` → requires a matching `*.spec.ts`.
- Tests are organized with nested `describe` blocks.
- All tests MUST pass (`yarn test`) before merge.

## Project Conventions

Standing technical decisions that apply across all features.

- **Language**: TypeScript with ESM-compatible imports.
- **Framework**: NestJS (CLI application pattern).
- **Package manager**: yarn (primary); npm for global linking only.
- **AI default**: `claude-sonnet-4-*` via `AiService`; override via `AI_MODEL`.
- **Variable naming**: camelCase with unit suffixes where relevant
  (e.g., `expiryInMs`, `ttlInSecs`, `artefactsDir`).
- **Utility functions**: declared as `const` arrow functions.
- **Error messages**: raised through dedicated helpers with clear formatting.
- **Platform auth**: Bitbucket and Jira use Atlassian API tokens
  (app passwords were deprecated 2025-09-09 and are no longer supported).

## Development Workflow

Standard delivery sequence for every feature:

1. **Fetch / Plan** — Generate a spec and implementation plan.
2. **Implement** — Write code on a feature branch following module boundaries
   (Principle IV).
3. **Test** — Run `yarn test`; all `.spec.ts` files MUST pass (Principle VIII).
4. **Build** — Run `yarn build`; MUST exit 0 (Principle VII).
5. **Review** — Run `wf issue:review` or open a PR.
6. **Commit** — Use `wf issue:commit` to enforce conventional commits
   (Principle III).

**Quality gates (in order):**

| Gate | Command | Blocks |
|------|---------|--------|
| Lint | `yarn lint` | Test run |
| Tests | `yarn test` | Build check |
| Build | `yarn build` | PR / manual test |
| Conventional commit | `wf issue:commit` | Merge |

## Governance

This constitution supersedes all other project-level practices. Guidance that
conflicts with a principle stated here is invalid until this document is
formally amended.

**Amendment procedure:**
1. Propose the change as a PR that modifies this file.
2. State the version bump type (MAJOR / MINOR / PATCH) and rationale in the
   PR description.
3. Update `LAST_AMENDED_DATE` and `CONSTITUTION_VERSION` in the footer.
4. Re-run `/speckit.constitution` to propagate changes to dependent templates.

**Versioning policy:**
- MAJOR: principle removal, redefinition, or backward-incompatible governance change.
- MINOR: new principle or materially expanded guidance added.
- PATCH: clarification, wording, or non-semantic refinement.

**Compliance review:**
- Every PR MUST verify the Constitution Check section of the relevant
  `plan.md` before merging.
- Principle VII (build gate) and Principle VIII (test coverage) are
  automatically enforced by the CI pipeline; the remaining principles
  require human review during code review.

**Version**: 1.0.0 | **Ratified**: 2026-03-28 | **Last Amended**: 2026-03-28
