---
name: do
description: 'End-to-end autonomous task executor. Takes a task description and handles the full lifecycle: research, plan, implement, review with specialist skills, best-effort CodeRabbit review, and merge via PR. Use when given a task to execute end-to-end.'
---

# End-to-End Task Executor

Read the full workflow from `.claude/commands/do.md` and execute it. Use `.claude/rules/00-rule-routing.md` to select only the rules needed for the changed paths before reading scoped `.claude/rules/` files.

## Quick Summary

1. **Research** — understand the request, search the codebase, read related docs
   - If the user explicitly asks for local subagent critique before implementation, gather bounded local subagent reviews and reconcile them before editing.
2. **Task file** — create in `tasks/backlog/`, commit to main
3. **Worktree** — create feature branch and worktree
4. **Implement** — follow checklist, push frequently, run quality checks. **For UI changes**: run mandatory Playwright visual audit with mock data on mobile + desktop viewports (see `.claude/rules/17-ui-visual-testing.md`)
5. **Validate** — full quality suite: lint, typecheck, test, build
6. **Review** — invoke local specialist skills / local subagents ($go-specialist, $cloudflare-specialist, etc.)
7. **Staging** — check for existing staging deploys (wait 5min if active), trigger manual deployment via `gh workflow run deploy-staging.yml --ref <branch>`. **Use `$CF_TOKEN` to query D1/KV/DNS directly** (see `.claude/rules/32-cf-api-debugging.md`) to verify migrations, data state, and feature flags — this is faster and more precise than UI-based checks. Then verify changed behavior end-to-end via Playwright. **For infrastructure changes** (cloud-init, VM agent, DNS, TLS, scripts/deploy): MUST provision a real VM and verify heartbeat arrives.
8. **PR** — create with `gh pr create`, wait for CI, then request CodeRabbit through the trusted GitHub Actions path: apply the `coderabbit-review` label with `gh pr edit <pr-number> --add-label coderabbit-review`; if the label run did not fire (it never fires on a draft PR), run `gh workflow run coderabbit-bot-review.yml --ref main -f pr_number=<pr-number>`. Do not post `@coderabbitai review` directly with an agent token. Then wait about 15 minutes. A CodeRabbit review is not required, but one that arrives blocks merge: implement or resolve every finding with a reason, and give incremental reviews after pushed fixes the same wait. If no review arrives (silence, `Review skipped`, rate limit), record that in the PR's CodeRabbit Review Evidence and continue. Do not re-trigger in a loop, and never add `needs-human-review` or wait for a waiver because CodeRabbit is silent (see `.claude/rules/25-review-merge-gate.md`). If the user requested draft PR / do-not-merge, stop at the draft PR and do not merge.
9. **Cleanup** — remove worktree, pull main

## ⚠️ Anti-Compaction: State File

Long `/do` runs lose context to compaction. You MUST maintain `.do-state.md` (gitignored) as external memory. Re-read it before every phase. See `.claude/rules/14-do-workflow-persistence.md`.
