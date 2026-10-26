#!/usr/bin/env bash
set -euo pipefail

scriptDir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skillContentDir="$scriptDir/../skills/content"
markerDir="$HOME/.claude/skill-gate-markers"
requiredSkills=("coding-style" "test-driven-development")
loadedSentinel="WF_SKILL_LOADED:"
denyInstructions="Skill gate: load the team skills before editing code in an interactive session. Invoke the Skill tool with \"coding-style\" and again with \"test-driven-development\", then retry this edit. Each skill is recorded automatically and only needs to be loaded once per session."
blockInstructions="Skill gate: this session edited code without loading the team skills. Run: ~/Projects/wf/src/hooks/skill-gate.sh load — read the printed coding-style and test-driven-development skills, re-check the edits you made against them (fix violations, add missing test coverage), then finish."

markerPathFor() {
  mkdir -p "$markerDir"
  printf '%s/%s.%s' "$markerDir" "$(printf '%s' "$1" | shasum -a 256 | cut -c1-16)" "$2"
}

sessionKeyFrom() {
  jq -r '.session_id // .cwd // empty' <<<"$1"
}

isCodeFile() {
  case "$1" in
    /tmp/*|/private/tmp/*) return 1 ;;
    *) ;;
  esac
  case "$1" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.vue|*.svelte|*.py|*.rb|*.go|*.rs|*.java|*.kt|*.swift) return 0 ;;
    *.c|*.cc|*.cpp|*.h|*.hpp|*.cs|*.php|*.sh|*.bash|*.zsh) return 0 ;;
    *) return 1 ;;
  esac
}

case "${1:-}" in
  check)
    [ "${WF_MANAGED_SESSION:-}" = "1" ] && exit 0
    input="$(cat)"
    filePath="$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")"
    { [ -n "$filePath" ] && isCodeFile "$filePath"; } || exit 0
    sessionKey="$(sessionKeyFrom "$input")"
    [ -n "$sessionKey" ] || exit 0
    allLoaded=1
    for skill in "${requiredSkills[@]}"; do
      [ -f "$(markerPathFor "$sessionKey" "$skill")" ] || allLoaded=0
    done
    [ "$allLoaded" = "1" ] && exit 0
    jq -cn --arg reason "$denyInstructions" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
    ;;
  mark)
    input="$(cat)"
    skill="$(jq -r '.tool_input.skill // empty' <<<"$input")"
    sessionKey="$(sessionKeyFrom "$input")"
    case " ${requiredSkills[*]} " in
      *" $skill "*)
        [ -n "$sessionKey" ] || exit 0
        date +%Y-%m-%dT%H:%M:%S%z > "$(markerPathFor "$sessionKey" "$skill")"
        find "$markerDir" -type f -mtime +7 -delete 2>/dev/null || true
        ;;
      *) ;;
    esac
    ;;
  check-stop)
    [ "${WF_MANAGED_SESSION:-}" = "1" ] && exit 0
    input="$(cat)"
    transcript="$(jq -r '.transcript_path // empty' <<<"$input")"
    { [ -n "$transcript" ] && [ -f "$transcript" ]; } || exit 0
    grep -qF 'apply_patch' "$transcript" || exit 0
    editEvidence="$(jq -r 'select(.type == "response_item"
        and (.payload.type? == "function_call" or .payload.type? == "custom_tool_call")
        and .payload.name? == "apply_patch") | "yes"' "$transcript" 2>/dev/null | head -n 1 || true)"
    [ "$editEvidence" = "yes" ] || exit 0
    allLoaded=1
    for skill in "${requiredSkills[@]}"; do
      grep -qF "$loadedSentinel $skill" "$transcript" || allLoaded=0
    done
    [ "$allLoaded" = "1" ] && exit 0
    jq -cn --arg reason "$blockInstructions" '{decision:"block",reason:$reason}'
    ;;
  load)
    for skill in "${requiredSkills[@]}"; do
      cat "$skillContentDir/$skill/SKILL.md"
      echo "$loadedSentinel $skill"
    done
    ;;
  *)
    echo "usage: skill-gate.sh {check|mark|check-stop|load}" >&2
    exit 64
    ;;
esac
