---
name: do
description: "End-to-end autonomous task executor. Takes a task description and handles the full lifecycle: research, plan, implement, review with specialist skills, and merge via PR. Use when given a task to execute end-to-end."
---

# End-to-End Task Executor

Read the full workflow from `.codex/prompts/do.md` and execute it.

## Quick Summary

1. **Research** — understand the request, search the codebase, read related docs
2. **Task file** — create in `tasks/backlog/`, commit to main
3. **Worktree** — create feature branch and worktree
4. **Implement** — follow checklist, push frequently, run quality checks. **For UI changes**: run mandatory Playwright visual audit with mock data on mobile + desktop viewports (see `.claude/rules/17-ui-visual-testing.md`)
5. **Validate** — full quality suite: lint, typecheck, test, build
6. **Review** — invoke specialist skills ($go-specialist, $cloudflare-specialist, etc.)
7. **Staging** — check for existing staging deploys (wait 5min if active), trigger manual deployment via `gh workflow run deploy-staging.yml --ref <branch>`, verify changed behavior end-to-end via Playwright. **For infrastructure changes** (cloud-init, VM agent, DNS, TLS, scripts/deploy): MUST provision a real VM and verify heartbeat arrives. See Phase 6b in `.codex/prompts/do.md`.
8. **PR** — create with `gh pr create`, wait for CI, merge when green
9. **Cleanup** — remove worktree, pull main

## ⚠️ Anti-Compaction: State File

Long `/do` runs lose context to compaction. You MUST maintain `.do-state.md` (gitignored) as external memory. Re-read it before every phase. See `.claude/rules/14-do-workflow-persistence.md`.
