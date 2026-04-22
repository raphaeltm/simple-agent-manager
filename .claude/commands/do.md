---
description: End-to-end task execution — research, plan, implement, review, and merge via PR
argument-hint: <task description>
---

## User Input

```text
$ARGUMENTS
```

You are an autonomous task executor. The user has described a task above. Your job is to take it from idea to merged PR with zero hand-holding. Follow every phase below in order.

---

## Phase 0: Initialize Workflow Tracker (MANDATORY FIRST STEP)

**Before doing ANYTHING else**, create a TodoWrite with all phases of this workflow. This todo list survives context compaction and ensures no phase is skipped even if the conversation is continued in a new session.

```
TodoWrite([
  { content: "Phase 1: Research & task creation", status: "pending", activeForm: "Researching codebase and creating task file" },
  { content: "Phase 2: Worktree setup", status: "pending", activeForm: "Setting up worktree and feature branch" },
  { content: "Phase 3: Implementation", status: "pending", activeForm: "Implementing changes" },
  { content: "Phase 4: Pre-PR validation (lint, typecheck, test, build)", status: "pending", activeForm: "Running full quality suite" },
  { content: "Phase 5: Review (dispatch specialist agents)", status: "pending", activeForm: "Running review agents" },
  { content: "Phase 6: Staging verification (deploy + Playwright)", status: "pending", activeForm: "Verifying on staging" },
  { content: "Phase 7: Create PR, wait for CI, merge", status: "pending", activeForm: "Creating and merging PR" },
])
```

You may add sub-tasks for implementation details, but these 7 phase-level items MUST remain in the todo list at all times. Mark each phase as `completed` only when ALL of its steps are done. If the conversation is resumed after compaction, check the todo list to determine which phase you are in and continue from there — do NOT re-read only the code summary.

Also create `.do-state.md` in the repo root (gitignored) as a complementary external memory file. See `.claude/rules/14-do-workflow-persistence.md` for the full spec. Re-read it at every phase boundary.

---

## Phase 1: Research & Task Creation

1. **Understand the request.** Parse the user input to identify:
   - What needs to change (feature, bug fix, refactor, etc.)
   - Which parts of the codebase are likely affected
   - Any constraints or preferences stated

2. **Research the codebase.** Before writing anything:
   - Search and read to find all relevant code paths
   - Read related docs in `docs/`, `specs/`, `.claude/rules/`
   - **Review relevant post-mortems** in `docs/notes/*-postmortem.md`. Search for post-mortems that touch the same subsystems, patterns, or failure modes as your task. Read at least the "What broke", "Root cause", and "Process fix" sections. These contain hard-won lessons about what goes wrong in this codebase — ignoring them risks repeating the exact same mistakes. If your task involves staging verification, credential handling, data flow across boundaries, or UI-to-backend paths, there is almost certainly a relevant post-mortem.
   - Use web search for external library/API docs if needed
   - Identify existing patterns, conventions, and test approaches in the affected areas

3. **Create a task file** in `tasks/backlog/` using the format `YYYY-MM-DD-descriptive-name.md`:
   - Problem statement (what and why)
   - Research findings (key files, patterns, dependencies discovered)
   - Detailed checklist of implementation steps
   - Acceptance criteria
   - References to relevant docs, specs, or rules

4. **Commit and push the task file directly to `main`:**
   ```
   git add tasks/backlog/<file>.md
   git commit -m "task: add <descriptive-name>"
   git push origin main
   ```

> **IMPORTANT**: Only the task file goes to main. All implementation work goes on a feature branch.

---

## Phase 2: Worktree Setup

1. **Create a feature branch and worktree:**
   ```
   git worktree add ../sam-<short-name> -b <branch-name>
   ```
   - Branch naming: use a descriptive kebab-case name
   - Worktree location: `../sam-<short-name>` (sibling to the main repo directory)

2. **Move the task file** from `tasks/backlog/` to `tasks/active/` in the worktree and commit.

3. **Install dependencies** in the worktree:
   ```
   cd ../sam-<short-name> && pnpm install
   ```

4. **Verify the starting state** — run `pnpm typecheck && pnpm lint` to confirm a clean baseline.

---

## Phase 3: Implementation

Execute the checklist from the task file. Follow these rules:

1. **Work through checklist items sequentially**, checking each off in the task file as you complete it.

2. **Follow project conventions:**
   - Obey all rules in `.claude/rules/`
   - Respect build order: `shared` -> `providers` -> `cloud-init` -> `api` / `web`
   - Update documentation in the same commit as code changes
   - Write tests that prove the feature works
   - No hardcoded values (constitution Principle XI)

3. **Push frequently.** After every meaningful unit of work:
   ```
   git add <specific-files>
   git commit -m "<type>: <description>"
   git push origin <branch-name>
   ```

4. **Run quality checks regularly** during implementation:
   - `pnpm typecheck` after type-related changes
   - `pnpm lint` after any code changes
   - `pnpm test` after adding/modifying tests

5. **Playwright visual audit (MANDATORY for UI changes).** If this PR touches any files in `apps/web/`, `packages/ui/`, or `packages/terminal/`, you MUST run a local Playwright visual audit before proceeding to Phase 4. See `.claude/rules/17-ui-visual-testing.md` for full requirements.

   - Use mock data covering: normal data, long text (200+ char titles), empty states, many items (30+), error states
   - Capture screenshots at both mobile (375x667) and desktop (1280x800) viewports
   - Store screenshots in `.codex/tmp/playwright-screenshots/`
   - Assert no horizontal overflow (`scrollWidth <= innerWidth`)
   - Fix any issues found before continuing

6. **Update `.do-state.md`** after every commit — check off completed implementation items and add notes.

---

> **Checkpoint (MANDATORY)**: Re-read `.do-state.md` AND the task file. Walk through every acceptance criterion and confirm it's met. Only proceed once you've verified completeness.

## Phase 4: Pre-PR Validation

Before creating the PR, ensure everything is solid:

1. **Run the full quality suite:**
   ```
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```
   Fix any failures before proceeding.

2. **Verify documentation sync** — grep for references to anything you changed and update stale docs.

3. **Run the task-completion-validator** (see `.claude/rules/09-task-tracking.md`). This validates that research findings became checklist items, checklist items are in the diff, acceptance criteria have tests, and UI inputs reach the backend. **CRITICAL/HIGH findings block merge — fix them now, do not defer to backlog.** The only exception is explicit human approval.

4. **Move the task file** from `tasks/active/` to `tasks/archive/` and commit.

---

## Phase 5: Review

Dispatch review based on what the PR touches. **Always include** the task-completion-validator in addition to domain-specific reviewers:

| PR touches | Skill | What it checks |
|------------|-------|----------------|
| **Always** | `$task-completion-validator` | Planned vs. actual work — research gaps, unwired UI, missing tests |
| Go code (`packages/vm-agent/`) | `$go-specialist` | Concurrency, resource leaks, Go idioms |
| TypeScript API (`apps/api/`) | `$cloudflare-specialist` | D1, KV, Workers patterns |
| UI code (`apps/web/`, `packages/ui/`) | `$ui-ux-specialist` | Accessibility, layout, interactions |
| Auth, credentials, tokens | `$security-auditor` | Credential safety, OWASP, JWT |
| Environment variables | `$env-validator` | GH_ vs GITHUB_, deployment mapping |
| Documentation changes | `$doc-sync-validator` | Docs match code reality |
| Business logic, config | `$constitution-validator` | No hardcoded values |
| Tests added/changed | `$test-engineer` | Coverage, realism, TDD compliance |

Address every bug or correctness issue raised. Push fixes and re-run quality checks.

**HARD STOP: Wait for ALL review agents to complete before proceeding.** If you launched reviewers in background, you MUST wait for their results and address findings before moving to Phase 6. Do NOT use idle time to jump ahead to PR creation. Context compaction WILL make you forget outstanding reviewers — the tracking mechanisms below exist specifically to prevent this.

**Update todo list and `.do-state.md`**: When dispatching reviewers, immediately add each one to the "Phase 5: Review Tracker" section with status `DISPATCHED`. Update each reviewer's status as results arrive. **Phase 5 CANNOT be marked complete until every dispatched reviewer shows `PASS` or `ADDRESSED`.** If any reviewer is still `DISPATCHED`, you are NOT done with Phase 5 — wait for it.

**Reviewer tracking is merge-blocking (see `.claude/rules/25-review-merge-gate.md`):**
1. When you create the PR in Phase 7, you MUST copy the review tracker into the PR description's "Specialist Review Evidence" section — one row per reviewer with their status and outcome.
2. If ANY reviewer is still `DISPATCHED` or `FAILED` at PR creation time, you MUST add the `needs-human-review` label and MUST NOT merge. The human will decide when to proceed.
3. Filing findings as backlog tasks does NOT count as "addressed" for CRITICAL/HIGH severity. Fix them or get human approval to defer.
4. Re-read `.do-state.md` and the todo list before EVERY phase transition. If you cannot confirm all reviewers completed, STOP.

---

## Phase 6: Staging Verification (BLOCKING — DO NOT SKIP)

> **Checkpoint**: Before entering Phase 6, re-read `.do-state.md` and verify the "Phase 5: Review Tracker" has ZERO reviewers with status `DISPATCHED`. Every reviewer must show `PASS` or `ADDRESSED`. If any reviewer is still outstanding, STOP — go back to Phase 5 and wait for it. If you have lost track of reviewer status due to context compaction, assume they are NOT complete — re-read `.do-state.md` to recover state. If `.do-state.md` is also incomplete, add `needs-human-review` label and do NOT merge.

If this PR includes **any code changes** (not just docs/tasks), deploy to staging and verify before creating the PR.

> **Skip this phase** only for documentation-only, config-only, or task-file-only changes.

### 6a. Standard Verification (All Code Changes)

1. **Check for existing staging deployments** before triggering your own:
   ```bash
   gh run list --workflow=deploy-staging.yml --status=in_progress --status=queued --json databaseId,status,createdAt,headBranch
   ```
   If there are active or queued runs, wait at least **5 minutes** from the most recent run's `createdAt` before triggering yours.

2. **Deploy to staging:**
   ```bash
   gh workflow run deploy-staging.yml --ref <your-branch-name>
   ```
   Then watch for completion:
   ```bash
   sleep 5
   gh run list --workflow=deploy-staging.yml --branch=<your-branch-name> --limit=1 --json databaseId,status
   gh run watch <run-id>
   ```
   If the deployment fails, inspect logs with `gh run view <run-id> --log-failed`, fix the issue, and re-trigger.

3. **Open the live app** using Playwright — navigate to `app.sammy.party` (staging).

4. **Authenticate** using the smoke test token via token-login API:
   ```
   POST https://api.sammy.party/api/auth/token-login
   Body: { "token": "<SAM_PLAYWRIGHT_PRIMARY_USER env var>" }
   ```
   If the env var is not set, ask the human for credentials.

5. **Verify the changed behavior works end-to-end:**
   - **UI changes**: interact as a real user — click buttons, submit forms, navigate pages
   - **API/backend changes**: verify affected endpoints respond correctly and downstream behavior works through the UI

6. **Report findings** to the user with evidence (screenshots or Playwright observations).

7. **If issues are found**, fix them in the branch, push, re-deploy, and re-verify. Do NOT proceed to PR creation with known staging failures.

### 6b. Infrastructure Verification (MANDATORY for Infrastructure Changes)

If the PR touches **any** of: `packages/cloud-init/`, `packages/vm-agent/`, `scripts/deploy/` (VM provisioning infrastructure), DNS record logic, TLS certificates, or VM agent port/protocol — you MUST complete these additional steps. **This is not optional. This is the gate that prevents catastrophic production failures.**

1. **Provision a real VM** — create a test workspace on staging that triggers full VM provisioning via cloud-init.
2. **Wait for heartbeat** — verify that the VM agent starts and sends heartbeats to the control plane within 2 minutes. If heartbeats do not arrive, the change is broken.
3. **Verify workspace access** — confirm the workspace is reachable via its `ws-*` subdomain and that terminal/agent sessions function.
4. **If TLS-related** — verify HTTPS connections to the VM agent succeed with valid certificate negotiation.
5. **Clean up** — delete the test workspace and node.
6. **Record evidence** — report to the user: "VM provisioned, heartbeat received at [time], workspace accessible at [URL]" or "FAILED: [specific failure]".

**If infrastructure verification fails, DO NOT create the PR. DO NOT merge. Fix the issue first.**

> **Why this is mandatory**: The TLS YAML indentation bug (`docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`) shipped to production because staging verification only checked UI rendering and API responses. Nobody provisioned a VM. The result: all workspace provisioning broke for ~2.5 hours in production.

### No Self-Exemptions

**Fixing a broken gate does not exempt you from the gate.** If staging is currently broken by the bug you are fixing, deploy your fix branch to staging and verify it *fixes* the broken state. "This is the fix for the thing the gate tests" is the **strongest** reason to run the gate, not a reason to skip it.

### If You Already Created the PR Without Completing Phase 6

You made a mistake. Close the PR, complete staging verification, then re-open. Do NOT merge a PR that skipped Phase 6 and "verify post-merge" — that is how bugs reach production.

---

## Phase 7: Pull Request

1. **Create the PR** using `gh pr create`:
   - Title: short, under 70 characters
   - Body: use the PR template from `.github/pull_request_template.md`

2. **Push and wait for CI.** Check GitHub Actions:
   ```
   gh pr checks <pr-number> --watch
   ```

3. **If CI fails:** inspect logs, fix issues, commit, push, repeat.

4. **Once CI is fully green**, merge the PR:
   ```
   gh pr merge <pr-number> --squash --delete-branch
   ```

5. **Clean up the worktree:**
   ```
   cd /workspaces/simple-agent-manager
   git worktree remove ../sam-<short-name>
   ```

6. **Pull main** to stay current:
   ```
   git pull origin main
   ```

7. **Delete `.do-state.md`** — the workflow is complete.

---

## Guiding Principles

- **Autonomy**: Complete the entire flow without asking the user unless genuinely blocked.
- **Transparency**: Report progress at each phase transition.
- **Safety**: Push often, never force-push, never commit to main (except the task file).
- **Quality**: Every shortcut now is a bug later. Follow the rules.
- **Iteration**: Review feedback is not optional — address it all.
