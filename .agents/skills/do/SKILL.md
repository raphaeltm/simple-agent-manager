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
4. **Implement** — follow checklist, push frequently, run quality checks
5. **Validate** — full quality suite: lint, typecheck, test, build
6. **Review** — invoke specialist skills ($go-specialist, $cloudflare-specialist, etc.)
7. **Staging** — deploy to staging, verify changed behavior end-to-end via Playwright. **For infrastructure changes** (cloud-init, VM agent, DNS, TLS, scripts/deploy): MUST provision a real VM and verify heartbeat arrives. See Phase 6b in `.codex/prompts/do.md`.
8. **PR** — create with `gh pr create`, wait for CI, merge when green
9. **Cleanup** — remove worktree, pull main
