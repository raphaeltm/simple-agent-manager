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

## Phase 1: Research & Task Creation

1. **Understand the request.** Parse the user input to identify:
   - What needs to change (feature, bug fix, refactor, etc.)
   - Which parts of the codebase are likely affected
   - Any constraints or preferences stated

2. **Research the codebase.** Before writing anything:
   - Search and read to find all relevant code paths
   - Read related docs in `docs/`, `specs/`, `.claude/rules/`
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

---

## Phase 4: Pre-PR Validation

Before creating the PR, ensure everything is solid:

1. **Run the full quality suite:**
   ```
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```
   Fix any failures before proceeding.

2. **Verify documentation sync** — grep for references to anything you changed and update stale docs.

3. **Run task completion validation** (BLOCKING — do not skip):
   Dispatch the `$task-completion-validator` agent with the active task file and current branch. This agent cross-references:
   - Research findings against the implementation checklist (did every identified problem get a checklist item?)
   - Checklist items against the git diff (did every checked item produce real code changes?)
   - Acceptance criteria against the test suite (does every criterion have test or manual verification?)
   - UI inputs against backend propagation (does every new form field reach the API?)
   - Multi-resource selection logic (do lookup functions accept a discriminator when multiple variants exist?)

   **If the validator reports FAIL**: fix every CRITICAL and HIGH finding before proceeding. Convert unaddressed research findings into checklist items (and implement them) or into explicit backlog tasks with references. Do NOT archive the task until the validator passes or all gaps are explicitly deferred.

4. **Move the task file** from `tasks/active/` to `tasks/archive/` and commit.

---

## Phase 5: Review

Dispatch review based on what the PR touches. **Always include** `$task-completion-validator` in addition to the domain-specific reviewers:

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

**STOP: Wait for all review agents to complete before proceeding.** If you launched reviewers in background, you MUST wait for their results and address findings before moving to Phase 6. Do NOT use idle time to jump ahead to PR creation.

---

## Phase 6: Staging Verification (BLOCKING — DO NOT SKIP)

If this PR includes **any code changes** (not just docs/tasks), deploy to staging and verify before creating the PR.

> **Skip this phase** only for documentation-only, config-only, or task-file-only changes.

### 6a. Standard Verification (All Code Changes)

1. **Deploy to staging:**
   ```
   pnpm deploy:setup --environment staging
   ```
   Or trigger the staging deployment via GitHub Actions.

2. **Open the live app** using Playwright — navigate to `app.sammy.party` (staging).

3. **Authenticate** using test credentials at `/workspaces/.tmp/secure/demo-credentials.md`. If the file is missing, ask the human for credentials.

4. **Verify the changed behavior works end-to-end:**
   - **UI changes**: interact as a real user — click buttons, submit forms, navigate pages
   - **API/backend changes**: verify affected endpoints respond correctly and downstream behavior works through the UI

5. **Report findings** to the user with evidence (screenshots or Playwright observations).

6. **If issues are found**, fix them in the branch, push, re-deploy, and re-verify. Do NOT proceed to PR creation with known staging failures.

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

---

## Guiding Principles

- **Autonomy**: Complete the entire flow without asking the user unless genuinely blocked.
- **Transparency**: Report progress at each phase transition.
- **Safety**: Push often, never force-push, never commit to main (except the task file).
- **Quality**: Every shortcut now is a bug later. Follow the rules.
- **Iteration**: Review feedback is not optional — address it all.
