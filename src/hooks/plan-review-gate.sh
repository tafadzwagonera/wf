#!/usr/bin/env bash
set -euo pipefail

markerDir="$HOME/.claude/plan-review-markers"
freshnessMinutes=60
reviewInstructions="Plan review gate: the plan skill review has not been recorded for this project. Complete it now — re-verify every line reference, return type, and call-chain claim against actual source, and have sub-agents adversarially review the plan for accuracy and design consistency. When the review passes, run: ~/Projects/wf/src/hooks/plan-review-gate.sh mark — then present the plan again."

markerPathFor() {
  mkdir -p "$markerDir"
  printf '%s/%s' "$markerDir" "$(printf '%s' "$1" | shasum -a 256 | cut -c1-16)"
}

isFresh() {
  [ -f "$1" ] && [ -n "$(find "$1" -mmin "-$freshnessMinutes" 2>/dev/null)" ]
}

case "${1:-}" in
  mark)
    targetDir="${2:-$PWD}"
    date +%Y-%m-%dT%H:%M:%S%z > "$(markerPathFor "$targetDir")"
    echo "Plan review recorded for $targetDir"
    ;;
  check)
    [ "${WF_MANAGED_SESSION:-}" = "1" ] && exit 0
    cwd="$(jq -r '.cwd // empty')"
    isFresh "$(markerPathFor "${cwd:-$PWD}")" && exit 0
    jq -cn --arg reason "$reviewInstructions" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
    ;;
  consume)
    cwd="$(jq -r '.cwd // empty')"
    rm -f "$(markerPathFor "${cwd:-$PWD}")"
    ;;
  check-stop)
    [ "${WF_MANAGED_SESSION:-}" = "1" ] && exit 0
    input="$(cat)"
    cwd="$(jq -r '.cwd // empty' <<<"$input")"
    transcript="$(jq -r '.transcript_path // empty' <<<"$input")"
    { [ -n "$transcript" ] && [ -f "$transcript" ]; } || exit 0
    lastAssistantMessage="$(tail -n 400 "$transcript" | jq -rs '
      map(select(.type == "response_item" and .payload.type? == "message" and .payload.role? == "assistant"))
      | last | .payload.content // [] | map(.text // "") | join("")' 2>/dev/null || true)"
    case "$lastAssistantMessage" in
      *'<proposed_plan'*) ;;
      *) exit 0 ;;
    esac
    marker="$(markerPathFor "${cwd:-$PWD}")"
    if isFresh "$marker"; then
      rm -f "$marker"
      exit 0
    fi
    jq -cn --arg reason "$reviewInstructions" '{decision:"block",reason:$reason}'
    ;;
  *)
    echo "usage: plan-review-gate.sh {mark [dir]|check|consume|check-stop}" >&2
    exit 64
    ;;
esac
