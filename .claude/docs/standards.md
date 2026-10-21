## Standards (read exemplar files on demand)

### Exemplar Files
When unsure about conventions, read these files as references:

- Spec style: `src/common/utils/execute-with-catch.spec.ts` — arrange/act/assert, describe blocks, mock setup/teardown
- Service pattern: `src/agents/fetcher.agent.ts` — constructor injection, public entry point, private helpers
- Schema convention: `src/shared/schemas/agent.schema.ts` — base schemas, `.extend()` composition, domain grouping

### Quality Rubric
- Tests: arrange/act/assert, one concept per test, no implementation coupling
- Services: single public entry point, private helpers, options object for >3 params
- Schemas: colocate with domain, derive types via `z.infer`, extend base schemas
