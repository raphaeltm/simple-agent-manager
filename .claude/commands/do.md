---
description: End-to-end task execution — research, plan, implement, review, CodeRabbit, and merge via PR
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
  { content: "Phase 5: Review (local specialist subagents)", status: "pending", activeForm: "Running local reviewer subagents" },
  { content: "Phase 6: Staging verification (deploy + Playwright)", status: "pending", activeForm: "Verifying on staging" },
  { content: "Phase 7: Finish CI and CodeRabbit on the ready PR, merge, monitor deploy", status: "pending", activeForm: "Completing PR gates and merging" },
])
```

You may add sub-tasks for implementation details, but these 7 phase-level items MUST remain in the todo list at all times. Mark each phase as `completed` only when ALL of its steps are done. If the conversation is resumed after compaction, check the todo list to determine which phase you are in and continue from there — do NOT re-read only the code summary.

Also create `.do-state.md` in the repo root (local-only, snapshot-visible; never commit) as a complementary external memory file. See `.claude/rules/14-do-workflow-persistence.md` for the full spec. Re-read it at every phase boundary.

---

## Phase 1: Research & Task Creation

1. **Understand the request.** Parse the user input to identify:
   - What needs to change (feature, bug fix, refactor, etc.)
   - Which parts of the codebase are likely affected
   - Any constraints or preferences stated

2. **Research the codebase.** Before writing anything:
   - Search and read to find all relevant code paths
   - Read related public docs in `apps/www/src/content/docs/docs/` and `specs/` only for affected behavior.
   - Read `.claude/rules/00-rule-routing.md`, then load only the root rules and scoped `.claude/rules/` files that match the directories you will modify. Do not bulk-load an app/package scoped rule directory.
   - **Review relevant post-mortems** by searching root rule stubs, matching scoped rule files, and relevant `tasks/archive/` records for the same subsystems, patterns, or failure modes as your task. Read at least the "What broke", "Root cause", and "Process fix" sections when a relevant incident lesson is found. If your task involves staging verification, credential handling, data flow across boundaries, or UI-to-backend paths, there is usually a relevant post-mortem.
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
   - Obey loaded root rules plus scoped rules selected through `.claude/rules/00-rule-routing.md` for the changed paths. If a file edit enters a new app/package, load that path's matching scoped rules before continuing.
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

   **After the first push, open the PR as a draft** so the work is visible and cheap checks run early:

   ```
   gh pr create --draft --title "<short title>" --body-file <filled-in .github/pull_request_template.md>
   ```

   CI on a draft PR runs only the quick checks: Detect Changes, PR Evidence, Lint, Build and Type Check, Code Quality Checks and Secret Scan. The test suites, browser audits, deploy-script, VM, CLI and Workers jobs start only when the PR is marked ready (Phase 4, step 5), and the required `Durable Object Workers` check is not reported for a draft run, so a draft can never be merged on quick checks. Push as often as you like while it is a draft. PR Evidence is expected to fail until the Specialist Review Evidence table is filled in; after the final body edit, re-run it with `gh run rerun <run-id> --failed` (body edits alone do not start CI, and the check reads the live body).

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

Before marking the PR ready for review, ensure everything is solid:

1. **Run the full quality suite:**

   ```
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```

   Fix any failures before proceeding.

2. **Verify documentation sync** — grep for references to anything you changed and update stale docs.

3. **Run the task-completion-validator** (see `.claude/rules/09-task-tracking.md`). This validates that research findings became checklist items, checklist items are in the diff, acceptance criteria have tests, and UI inputs reach the backend. **CRITICAL/HIGH findings block merge — fix them now, do not defer to backlog.** The only exception is explicit human approval.

4. **Move the task file** from `tasks/active/` to `tasks/archive/` and commit.

5. **Mark the PR ready for review as soon as the candidate is complete**, and request CodeRabbit at the same moment. Do not wait for reviewers or staging; they run in parallel with CI and CodeRabbit (Phases 5 and 6):

   ```
   gh pr ready <pr-number>
   gh pr edit <pr-number> --add-label coderabbit-review
   ```

   `ready_for_review` starts the full CI suite on the current commit. Every later push to the ready PR re-runs the full suite and cancels the superseded run, so batch review and staging fixes into as few pushes as practical. If the label run did not fire, dispatch `gh workflow run coderabbit-bot-review.yml --ref main -f pr_number=<pr-number>` once (see Phase 7, steps 4 and 5, for the wait rules).

   If the user asked for a draft PR or "do not merge", do not mark it ready. Get the full suite with `gh workflow run ci.yml --ref <branch-name>` instead (it runs the path-filtered jobs your change triggers, minus the PR-only Playwright visual audit and PR Evidence, and does not report the required merge check), and stop at the draft PR.

---

## Phase 5: Review

Run local subagent review based on what the PR touches. **Always include** the task-completion-validator in addition to domain-specific local reviewers. Do **not** create SAM child tasks for routine `/do` Phase 5 review; SAM child tasks are only for explicit user-requested SAM subtasks or visible delegated SAM work:

| PR touches                            | Skill                        | What it checks                                                     |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| **Always**                            | `$task-completion-validator` | Planned vs. actual work — research gaps, unwired UI, missing tests |
| Go code (`packages/vm-agent/`)        | `$go-specialist`             | Concurrency, resource leaks, Go idioms                             |
| TypeScript API (`apps/api/`)          | `$cloudflare-specialist`     | D1, KV, Workers patterns                                           |
| UI code (`apps/web/`, `packages/ui/`) | `$ui-ux-specialist`          | Accessibility, layout, interactions                                |
| Auth, credentials, tokens             | `$security-auditor`          | Credential safety, OWASP, JWT                                      |
| Environment variables                 | `$env-validator`             | GH* vs GITHUB*, deployment mapping                                 |
| Documentation changes                 | `$doc-sync-validator`        | Docs match code reality                                            |
| Business logic, config                | `$constitution-validator`    | No hardcoded values                                                |
| Tests added/changed                   | `$test-engineer`             | Coverage, realism, TDD compliance                                  |

Address every bug or correctness issue raised. Push fixes and re-run quality checks.

**HARD STOP: Wait for ALL local subagents to complete before proceeding.** If local reviewers are running in the background, you MUST wait for their results and address findings before moving to Phase 6. Do NOT use idle time to jump ahead to merging. Context compaction WILL make you forget outstanding reviewers — the tracking mechanisms below exist specifically to prevent this.

**Update todo list and `.do-state.md`**: When starting local reviewers, immediately add each one to the "Phase 5: Review Tracker" section with status `PENDING`. Update each reviewer's status as results arrive. **Phase 5 CANNOT be marked complete until every local reviewer shows `PASS` or `ADDRESSED`.** If any reviewer is still `PENDING`, you are NOT done with Phase 5 — wait for it.

**Reviewer tracking is merge-blocking (see `.claude/rules/25-review-merge-gate.md`):**

1. Before merging, you MUST copy the review tracker into the PR description's "Specialist Review Evidence" section — one row per reviewer with their status and outcome. The PR already exists (draft since Phase 3, ready since Phase 4); update its body.
2. If ANY reviewer is still `PENDING` or `FAILED` when you are ready to merge, you MUST add the `needs-human-review` label and MUST NOT merge. The human will decide when to proceed.
3. Filing findings as backlog tasks does NOT count as "addressed" for CRITICAL/HIGH severity. Fix them or get human approval to defer.
4. Re-read `.do-state.md` and the todo list before EVERY phase transition. If you cannot confirm all reviewers completed, STOP.

---

## Phase 6: Staging Verification (BLOCKING — DO NOT SKIP)

> **Checkpoint**: Before entering Phase 6, re-read `.do-state.md` and verify the "Phase 5: Review Tracker" has ZERO reviewers with status `PENDING`. Every reviewer must show `PASS` or `ADDRESSED`. If any reviewer is still outstanding, STOP — go back to Phase 5 and wait for it. If you have lost track of reviewer status due to context compaction, assume they are NOT complete — re-read `.do-state.md` to recover state. If `.do-state.md` is also incomplete, add `needs-human-review` label and do NOT merge.

If this PR includes **any code changes** (not just docs/tasks), deploy to staging and verify before merging the PR.

> **Skip this phase** only for documentation-only, config-only, or task-file-only changes.

### 6a. Standard Verification (All Code Changes)

1. **Read the queue of both installations** (one `gh api` call each):

   ```bash
   node scripts/deploy/staging-lease.mjs status staging2   # and: status staging
   # Raw records, newest first (a `snapshot` plus newer `reservation` events):
   gh api 'repos/raphaeltm/simple-agent-manager/deployments?environment=staging2&task=staging-lease&per_page=100' \
     --jq '[.[] | {id, payload}]'
   ```

   `status` prints the holder, whether the slot is free, and the ordered queue
   (branch, SAM task ID, reserved-at, turn window). There are two staging
   installations, `staging` (`sammy.party`) and `staging2` (`sammy2.party`); pick the
   one that is free or has the shorter queue and use that name in every command
   below. They share the `staging` credentials but nothing else. staging2 sign-in is
   workload identity only; see "Two Staging Installations" in the full reference.

2. **Reserve first, then deploy only on your turn.** Reserving takes seconds and
   deploys nothing:

   ```bash
   gh workflow run deploy-staging.yml --ref <your-branch> \
     -f environment=staging2 -f lease_action=reserve -f sam_task_id=<your-task-id>
   ```

   The run summary shows your position and estimated turn. When the slot is free
   (holder released, or its lease expired), only the head of the queue may take it,
   for `STAGING_LEASE_GRACE_MINUTES` (default 10); if it does not, the next entry
   gets its own grace period and the missed one is dropped. If the holder released
   early, the head's turn still lasts until the holder's announced expiry plus grace.
   Schedule a one-time SAM wake (`schedules_write`, method `create`,
   `message_session` for your session) at your turn start, persist the schedule ID,
   and end the turn or do independent work. Do not poll, and **never dispatch a
   deploy while another branch holds the lease or it is another branch's turn**: the
   run is refused (your place is kept). A reservation expires after
   `STAGING_LEASE_RESERVATION_MINUTES` (default 480) unless renewed by reserving
   again, which keeps your place.

   On your turn, deploy (or `-f lease_action=acquire` to hold without deploying):

   ```bash
   gh workflow run deploy-staging.yml --ref <your-branch> \
     -f environment=staging2 -f sam_task_id=<your-task-id> -f lease_hold_minutes=30
   ```

   A deploy dispatch also reserves if you are not queued yet, and goes straight
   through when the slot is free and nobody is waiting. The `queue` job records
   places outside any concurrency group, so no later dispatch can cancel your place;
   only a branch that holds the lease or whose turn it is reaches the serialized
   `lease` job. Same-branch redeploys renew the lease. Expiry is acquisition time
   plus expected deployment time (`STAGING_LEASE_EXPECTED_DEPLOY_MINUTES`, default
   30; zero for `acquire`) plus the live-check hold
   (`STAGING_LEASE_DEFAULT_HOLD_MINUTES`, default 30, capped by
   `STAGING_LEASE_MAX_HOLD_MINUTES`, default 120). Failed or cancelled runs keep the
   lease until release or expiry.

3. **Watch the run and verify live**, then **release** and hand over:

   ```bash
   gh run list --workflow=deploy-staging.yml --branch=<your-branch> --limit=3 \
     --json databaseId,status,conclusion,headSha
   gh run watch <run-id>
   # After live checks and test-resource cleanup:
   gh workflow run deploy-staging.yml --ref <your-branch> \
     -f environment=staging2 -f lease_action=release -f sam_task_id=<your-task-id>
   ```

   Confirm the release run passed and `status` shows no holder. Release also
   removes you from the queue if you were waiting. A branch that releases and wants
   the slot again queues behind everyone already waiting. **If you release early,
   message the next task in the queue** (`send_durable_message` to its SAM task ID
   from `status`) so it can take its turn before its scheduled wake. Successful
   deployment completion is not a release. Release only after your own deploy run
   has finished: the next holder's deploy waits for an in-flight one in the
   `staging-apply-<installation>` group, but your live checks are no longer
   protected once you release.

   Records are GitHub deployments with task `staging-lease`, keyed by installation.
   A malformed snapshot or an unknown record version fails closed (no one can
   change the lease until it is fixed through a reviewed change; never delete
   history to get around another branch); a malformed reservation is skipped and
   reported in the run. Branches whose workflow copy predates the queue are refused
   by every queue record ("Malformed lease record"): they cannot reserve, deploy,
   acquire or release until they update from `origin/main`. Only the `queue` and
   `lease` jobs receive `deployments: write`; lease writes must go through the
   workflow.

4. **Open the live app** using Playwright — navigate to `app.sammy.party` (staging) or `app.sammy2.party` (staging2).

5. **Authenticate** using the smoke test token via token-login API:

   ```
   POST https://api.sammy.party/api/auth/token-login
   Body: { "token": "<SAM_PLAYWRIGHT_PRIMARY_USER env var>" }
   ```

   Do this inside Playwright so the browser context receives the session cookie, then navigate that browser to `https://app.sammy.party`. Do not exchange the staging smoke/API token against `SAM_API_URL`; these tokens correctly fail against production.
   If the env var is not set, ask the human for credentials.

   On `staging2` (`sammy2.party`), sign in with your workload identity instead (audience
   `https://api.sammy2.party/api/auth/workload-identity-login`, target `staging2-agent-user` or
   `staging2-agent-admin`); see "Two Staging Installations" in the full reference.

6. **Verify the changed behavior works end-to-end:**
   - **UI changes**: interact as a real user — click buttons, submit forms, navigate pages
   - **API/backend changes**: verify affected endpoints respond correctly and downstream behavior works through the UI

7. **Report findings** to the user with evidence (screenshots or Playwright observations).

8. **If issues are found**, fix them in the branch, push, re-deploy, and re-verify. Do NOT merge with known staging failures.

### 6b. Infrastructure Verification (MANDATORY for Infrastructure Changes)

If the PR touches **any** of: `packages/cloud-init/`, `packages/vm-agent/`, `scripts/deploy/` (VM provisioning infrastructure), DNS record logic, TLS certificates, or VM agent port/protocol — you MUST complete these additional steps. **This is not optional. This is the gate that prevents catastrophic production failures.**

1. **Provision a real VM** — create a test workspace on staging that triggers full VM provisioning via cloud-init.
2. **Wait for heartbeat** — verify that the VM agent starts and sends heartbeats to the control plane within 2 minutes. If heartbeats do not arrive, the change is broken.
3. **Verify workspace access** — confirm the workspace is reachable via its `ws-*` subdomain and that terminal/agent sessions function.
4. **If TLS-related** — verify HTTPS connections to the VM agent succeed with valid certificate negotiation.
5. **Clean up** — delete the test workspace and node.
6. **Record evidence** — report to the user: "VM provisioned, heartbeat received at [time], workspace accessible at [URL]" or "FAILED: [specific failure]".

**If infrastructure verification fails, DO NOT merge. Fix the issue first.**

> **Why this is mandatory**: The TLS YAML indentation bug (the retained incident lesson in this rule) shipped to production because staging verification only checked UI rendering and API responses. Nobody provisioned a VM. The result: all workspace provisioning broke for ~2.5 hours in production.

### No Self-Exemptions

**Fixing a broken gate does not exempt you from the gate.** If staging is currently broken by the bug you are fixing, deploy your fix branch to staging and verify it _fixes_ the broken state. "This is the fix for the thing the gate tests" is the **strongest** reason to run the gate, not a reason to skip it.

### A Ready PR Is Not Permission to Merge

The PR is open as a draft from Phase 3 and ready from Phase 4, so CI and CodeRabbit run while you verify staging. That is intended. What is forbidden is merging before Phase 6 passes. Do NOT merge a PR that skipped Phase 6 and "verify post-merge" — that is how bugs reach production.

---

## Phase 7: Pull Request, CodeRabbit Review & Post-Merge Deploy Monitoring

1. **Make sure the PR is open and ready.** It was opened as a draft in Phase 3 and marked ready in Phase 4. If it does not exist yet, create it with `gh pr create` (title under 70 characters, body from `.github/pull_request_template.md`), not as a draft; if it is still a draft, run `gh pr ready <pr-number>`. Update the body with the review tracker and staging evidence.

2. **Push and wait for the full CI run on the ready PR.** Quick-check results from draft runs do not count. The required `Durable Object Workers` check reports only after every job of the ready run has finished, and fails if any of them failed. Check GitHub Actions:

   ```
   gh pr checks <pr-number> --watch
   ```

3. **If CI fails:** inspect logs, fix issues, commit, push, repeat.

4. **CodeRabbit is requested when the PR is marked ready (Phase 4, step 5)**, in parallel with CI, local reviewers and staging, not after them. If that did not happen (for example the PR was created late), request it now. Use the repository's trusted GitHub Actions path, not a `@coderabbitai review` comment of your own. Apply the opt-in label first:

   ```
   gh pr edit <pr-number> --add-label coderabbit-review
   ```

   If the label-triggered run did not fire (the label path never fires on a draft PR), dispatch the same workflow from `main`:

   ```
   gh workflow run coderabbit-bot-review.yml --ref main -f pr_number=<pr-number>
   ```

   Agents MUST NOT post `@coderabbitai review` directly with their own GitHub App token; CodeRabbit ignores bot-authored review commands. The workflow is the human-identity bridge.

5. **Wait about 15 minutes from the request for CodeRabbit, then follow whichever case applies.** The wait ends at once when CodeRabbit replies with a rate-limit, quota or `Review skipped` notice, or the request workflow fails. If you have nothing else to do while waiting, you may subscribe to the PR's review and comment events (`create_project_event_subscription`, source `github`, subjectType `pull_request`, subjectId = the PR number; `requestedDelivery` defaults to `runtime_steer`) and end your turn instead of sleeping in a loop; only PR comment wakes of a live chat are verified so far, so still check the PR once when the wait ends and say if eventing did not wake you. If CodeRabbit has visibly started a review that is still in progress, let it finish, up to about 45 minutes in total. A CodeRabbit review is not required; requesting one and waiting is. See `.claude/rules/25-review-merge-gate.md`.
   - **A review arrived: it blocks merge until its feedback is resolved.** Read every CodeRabbit review comment, thread, and summary. Implement valid feedback, push fixes, and re-run the affected validation/CI checks. For feedback you believe is not applicable, explicitly review it, document the reason, and resolve the thread. Keep the `coderabbit-review` label on the PR so pushed fixes get incremental reviews, and give each one the same wait. You are done when no CodeRabbit feedback is unresolved and you independently agree the PR is ready. CodeRabbit not re-reviewing your fixes within the wait does not block.
   - **No review arrived: skip CodeRabbit and continue.** This covers silence after the wait, a `Review skipped` status (for example `bot user not eligible for review`), a rate-limit or quota notice, and a failed request workflow. Record what you observed in the PR's "CodeRabbit Review Evidence" section. **Do NOT add `needs-human-review`, call `request_human_input`, or wait for a waiver because CodeRabbit is silent.**

   Do not re-trigger CodeRabbit in a loop; request again only for a materially new ready state. A review that lands after you stopped waiting but before merge is binding. One that lands after merge goes through a follow-up PR.

6. **Once CI is fully green and the CodeRabbit step is complete** (its feedback resolved, or no review arrived within the wait), merge the PR:

   ```
   gh pr merge <pr-number> --squash --delete-branch
   ```

7. **Clean up the worktree:**

   ```
   cd /workspaces/simple-agent-manager
   git worktree remove ../sam-<short-name>
   ```

8. **Pull main** to stay current:
   ```
   git pull origin main
   ```

### 7b. Post-Merge Production Deploy Monitoring (MANDATORY)

After merging to main, you MUST monitor the production deployment to completion. **Do NOT consider the task done until the deploy succeeds or you have alerted the user about a failure.**

1. **Wait for the Deploy Production workflow to start** (usually within 30 seconds of merge):

   ```bash
   sleep 10
   gh run list --workflow=deploy.yml --branch=main --limit=1 --json databaseId,status,conclusion,createdAt
   ```

2. **Watch it to completion:**

   ```bash
   gh run watch <run-id>
   ```

3. **If the deploy succeeds**: Report to the user: "Production deploy succeeded. Changes are live."

4. **If the deploy FAILS**: This is critical. You MUST:
   - Immediately inspect the failure: `gh run view <run-id> --log-failed`
   - **Alert the user immediately** with:
     - The fact that the production deploy failed
     - The specific failure reason (e.g., missing secret, build error, Pulumi failure)
     - Whether this is something the agent can fix (code issue) or requires human intervention (missing secrets, infrastructure config)
   - If it's a code issue you introduced: fix it, push to main, and monitor the next deploy
   - If it requires human intervention (missing secrets, permissions, external config): **tell the user explicitly what action they need to take** and do NOT silently move on
   - **A successful Deploy Production run that deployed nothing** means a newer commit reached `main` first, or the tip was already deployed: the automatic gate always deploys the current main tip, and only once the tip's own CI succeeded. Your change ships with the tip's deploy; monitor that run instead (`gh run list --workflow=deploy.yml --limit=5`).

5. **Check for pre-existing deploy failures**: Before monitoring your own deploy, check if recent deploys have been failing:
   ```bash
   gh run list --workflow=deploy.yml --limit=5 --json conclusion,createdAt,displayTitle
   ```
   If the last several deploys have all failed, **alert the user immediately** — there may be a systemic configuration issue that is blocking all deployments. Do not assume your merge will deploy successfully just because CI passed.

> **Why this is mandatory**: On 2026-04-23, production deploys failed silently for 2 days due to a missing `GH_WEBHOOK_SECRET`. Multiple agents merged PRs without noticing. 6+ changes accumulated undeployed with no one aware. This step exists to ensure deploy failures are caught immediately, not days later.

7. **Delete `.do-state.md`** — the workflow is complete.

---

## Guiding Principles

- **Autonomy**: Complete the entire flow without asking the user unless genuinely blocked.
- **Transparency**: Report progress at each phase transition.
- **Safety**: Push often, never force-push, never commit to main (except the task file).
- **Quality**: Every shortcut now is a bug later. Follow the rules.
- **Iteration**: Review feedback is not optional — address it all.
- **Deploy awareness**: A merged PR is not shipped until the deploy succeeds. Monitor it.
