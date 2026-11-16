#!/bin/bash
# log-instructions-loaded.sh — InstructionsLoaded hook (Claude Code).
#
# Appends one JSON line per instruction file Claude Code loads into context
# (CLAUDE.md and .claude/rules/*.md, at session start and on lazy loads) to
# .tmp/instruction-loads/<session_id>.jsonl. This is the ground truth for what
# a session actually received; scripts/quality/check-agent-context-budget.ts
# --observed compares it with the static model.
#
# The event cannot block and its output is discarded, so this script must never
# fail a session: every error path exits 0.

INPUT=$(cat 2>/dev/null || true)
command -v jq >/dev/null 2>&1 || exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)
SESSION=$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9._-' '_')
FILE=$(printf '%s' "$INPUT" | jq -r '.file_path // empty' 2>/dev/null)
[ -n "$FILE" ] || exit 0

BYTES=0
[ -f "$FILE" ] && BYTES=$(wc -c <"$FILE" 2>/dev/null | tr -d ' ')

OUT_DIR="$ROOT/.tmp/instruction-loads"
mkdir -p "$OUT_DIR" 2>/dev/null || exit 0

printf '%s' "$INPUT" | jq -c --arg root "$ROOT/" --argjson bytes "${BYTES:-0}" '{
  at: (now | todate),
  session_id,
  agent_id: (.agent_id // null),
  load_reason,
  memory_type,
  file: (.file_path | ltrimstr($root)),
  trigger: ((.trigger_file_path // null) | if . == null then null else ltrimstr($root) end),
  globs: (.globs // null),
  bytes: $bytes
}' >>"$OUT_DIR/${SESSION:-unknown}.jsonl" 2>/dev/null

exit 0
