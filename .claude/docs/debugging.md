## Debugging CLI Commands
When debugging `wf` commands, verify:
1. `LOG_LEVEL` is valid (config: `log.level`)
2. The active provider's API key is set: `ANTHROPIC_API_KEY` (default), `OPENAI_API_KEY`, or `GEMINI_API_KEY` — controlled by `ai[].provider` and per-stage overrides in `stages.<command>.provider`
3. Command routing follows the NestJS pattern

Reference: `src/commands/issue-plan.command.ts`
