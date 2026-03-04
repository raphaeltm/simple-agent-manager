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

3. **Move the task file** from `tasks/active/` to `tasks/archive/` and commit.

---

## Phase 5: Review

Dispatch review based on what the PR touches:

| PR touches | Skill | What it checks |
|------------|-------|----------------|
| Go code (`packages/vm-agent/`) | `$go-specialist` | Concurrency, resource leaks, Go idioms |
| TypeScript API (`apps/api/`) | `$cloudflare-specialist` | D1, KV, Workers patterns |
| UI code (`apps/web/`, `packages/ui/`) | `$ui-ux-specialist` | Accessibility, layout, interactions |
| Auth, credentials, tokens | `$security-auditor` | Credential safety, OWASP, JWT |
| Environment variables | `$env-validator` | GH_ vs GITHUB_, deployment mapping |
| Documentation changes | `$doc-sync-validator` | Docs match code reality |
| Business logic, config | `$constitution-validator` | No hardcoded values |
| Tests added/changed | `$test-engineer` | Coverage, realism, TDD compliance |

Address every bug or correctness issue raised. Push fixes and re-run quality checks.

---

## Phase 6: Pull Request

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
