#!/bin/bash
# Seeds a disposable test repository with SAM's Codex hooks and a canary rule, so a fresh
# SAM Codex session on it can show whether repository hooks run (scripts/quality/README.md,
# "Codex hooks"). Run from the root of the test repository's checkout; it commits and pushes
# to the repository's main branch, so never run it in a repository that matters.
#
# Usage: seed-codex-hook-probe.sh <simple-agent-manager git ref (commit SHA)>
set -euo pipefail

ref=${1:?usage: seed-codex-hook-probe.sh <simple-agent-manager ref>}
raw="https://raw.githubusercontent.com/raphaeltm/simple-agent-manager/$ref"

fetch() { curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 "$raw/$1"; }

mkdir -p .codex/hooks .claude/hooks .claude/rules src
fetch .codex/hooks/rule-context.mjs >.codex/hooks/rule-context.mjs
fetch .claude/hooks/verify-test-quality.mjs >.claude/hooks/verify-test-quality.mjs
# The hook entries of SAM's own .codex/config.toml, without its project table.
fetch .codex/config.toml |
  sed -n '/^\[\[hooks.SessionStart\]\]/,/^\[projects/p' | sed '/^\[projects/d' >.codex/config.toml

cat >.claude/rules/10-probe.md <<'RULE'
---
paths:
  - 'src/**'
---

# Probe Rule

PROBE-RULE-CANARY-7731: files under src/ follow this probe rule.
RULE
cat >.codex/hooks/rule-scopes.json <<'JSON'
{"rules":[{"path":".claude/rules/10-probe.md","title":"Probe Rule","patterns":[{"pattern":"src/**","regex":"^src\\/.*$","literal":4}]}]}
JSON
printf 'hello\n' >src/existing.txt
printf '.tmp/\n' >>.gitignore

grep -q '^\[\[hooks.Stop\]\]' .codex/config.toml
git add .codex .claude src .gitignore
git commit -qm "probe: Codex hooks and a canary rule"
git push -q origin HEAD:main
git rev-parse HEAD
