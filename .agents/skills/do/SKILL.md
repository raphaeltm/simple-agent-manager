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
4. **Implement** — follow checklist, push frequently, run quality checks. After the first push open the PR as a draft (`gh pr create --draft`); draft PRs run only quick CI checks. **For UI changes**: run mandatory Playwright visual audit with mock data on mobile + desktop viewports (see `.claude/rules/17-ui-visual-testing.md`)
5. **Validate** — full quality suite: lint, typecheck, test, build. As soon as the candidate is complete, mark the PR ready (`gh pr ready <pr-number>`), which starts the full CI suite, and request CodeRabbit at the same moment; reviews and staging then run in parallel with CI and CodeRabbit
6. **Review** — invoke local specialist skills / local subagents ($go-specialist, $cloudflare-specialist, etc.)
7. **Staging** — read the latest environment-keyed GitHub deployment lease (`task=staging-lease`); when held by another branch, schedule a SAM wake at `expiresAt` instead of polling or chatting. Trigger `gh workflow run deploy-staging.yml --ref <branch> -f sam_task_id=<task-id>` to acquire/renew before deployment; after live checks release with the same command plus `-f lease_action=release` and confirm success. Configurable hold defaults/cap and commands: `.agent-instructions/reference/rules/13-staging-verification-full.md`. **Use `$CF_TOKEN` to query D1/KV/DNS directly** (see `.claude/rules/32-cf-api-debugging.md`) to verify migrations, data state, and feature flags — this is faster and more precise than UI-based checks. Then verify changed behavior end-to-end via Playwright. **For infrastructure changes** (cloud-init, VM agent, DNS, TLS, scripts/deploy): MUST provision a real VM and verify heartbeat arrives.
8. **PR** — the PR is already ready from step 5 (create it now if not, not as a draft). Wait for the full CI run on the ready PR (the required `Durable Object Workers` check reports only after every job finished). CodeRabbit is requested when the PR is marked ready, through the trusted GitHub Actions path: apply the `coderabbit-review` label with `gh pr edit <pr-number> --add-label coderabbit-review`; if the label run did not fire (it never fires on a draft PR), run `gh workflow run coderabbit-bot-review.yml --ref main -f pr_number=<pr-number>`. Do not post `@coderabbitai review` directly with an agent token. Then wait about 15 minutes from the request, ending at once on a `Review skipped`, rate-limit or quota reply. A CodeRabbit review is not required, but one that arrives blocks merge: implement or resolve every finding with a reason, and give incremental reviews after pushed fixes the same wait. If no review arrives (silence, `Review skipped`, rate limit), record that in the PR's CodeRabbit Review Evidence and continue. Do not re-trigger in a loop, and never add `needs-human-review` or wait for a waiver because CodeRabbit is silent (see `.claude/rules/25-review-merge-gate.md`). If the user requested draft PR / do-not-merge, do not mark it ready; get the full suite with `gh workflow run ci.yml --ref <branch>`, stop at the draft PR and do not merge.
9. **Cleanup** — remove worktree, pull main

## ⚠️ Anti-Compaction: State File

Long `/do` runs lose context to compaction. You MUST maintain `.do-state.md` (local-only, snapshot-visible; never commit) as external memory. Re-read it before every phase. See `.claude/rules/14-do-workflow-persistence.md`.
