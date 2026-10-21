## Config Structure (`wf.config.ts`)
- `ai[]` — provider entries (anthropic, openai, google) with `default: true` to set the default
- `stages.<command>` — per-stage overrides: `provider`, `agent` (boolean), `verificationConditions`
- `stages.implement.designConformance` — optional advisory check of the implement diff against UI design screenshots; default off
  - `enabled` (boolean, default `false`), `maxScreenshots` (positive integer, default no cap); no other keys are accepted
  - Provider and model come from `stages.implement.planStepVerification.provider` / `.model` (`.model` alone uses the implement stage provider); when neither is set the implement stage defaults apply. `planStepVerification.backend` is ignored. The resolved provider must be anthropic or openai, otherwise the check is skipped with a warning.
  - Makes one sequential call per screenshot, so it costs roughly N times a single call on the resolved model.
  - Findings are printed, logged under `design-check`, and stored in the implement run file as `designConformance`. They never fail the run.
- `atlassian`, `slack`, `git`, `branching`, `state`, `log`, `app`, `workflows`, `output`

## Environment variables
- `WF_HOME` — absolute path relocating the artifact, log, and state tree (default `~/.wf`). A relative value is silently ignored.
- `WF_REPOS_DIR` — absolute path to the directory containing your repository checkouts, used to resolve `-r/--repos` tokens from any cwd. When set, it is the only base probed; default probing is disabled.
  - Unset: bases `$HOME/Apps`, `$HOME/Projects`, `$HOME/apps`, `$HOME/projects` are probed in order, derived from `os.homedir()` and never from `WF_HOME`.
  - Relative value: ignored with a one-time warning; the defaults apply.
  - No tilde expansion: the shell expands `~` before wf sees the value.
  - On macOS's case-insensitive APFS the lowercase defaults alias the capitalised ones; they only matter on Linux.
