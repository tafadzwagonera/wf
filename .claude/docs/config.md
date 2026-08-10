## Config Structure (`wf.config.ts`)
- `ai[]` — provider entries (anthropic, openai, google) with `default: true` to set the default
- `stages.<command>` — per-stage overrides: `provider`, `agent` (boolean), `verificationConditions`
- `atlassian`, `slack`, `git`, `branching`, `state`, `log`, `app`, `workflows`, `output`
