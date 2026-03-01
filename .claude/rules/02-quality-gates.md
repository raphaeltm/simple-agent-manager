# Quality Gates

## Request Validation (After Every Task)

After completing ANY task, you MUST re-read the user's original request and verify your work fully addresses it.

1. Scroll back to the user's last message that initiated the task
2. Compare what was requested vs. what was delivered
3. Explicitly confirm each requested item was addressed
4. Acknowledge any items that were deferred or handled differently
5. Do NOT mark work as complete until this validation passes

## Feature Testing Requirements

If you build or modify a feature, you MUST add tests that prove it works before calling the task complete.

1. Add unit tests for new and changed logic/components
2. Add integration tests when multiple layers interact (API routes/services/DB, UI + API data loading, auth flows)
3. Add end-to-end tests for user-critical flows when applicable
4. Run relevant test suites and confirm they pass before completion
5. Manual QA alone is NOT sufficient coverage

### Quick Testing Gate

Before marking feature work complete:
- [ ] Unit tests added/updated for all changed behavior
- [ ] Integration tests added where cross-layer behavior exists
- [ ] Capability test verifies complete happy path across system boundaries (see `10-e2e-verification.md`)
- [ ] E2E coverage added or explicitly justified as not applicable
- [ ] Local test run passes for impacted packages
- [ ] CI test checks are expected to pass with the changes

### Test Locations

- Unit tests: `tests/unit/` in each package
- Integration tests: `apps/api/tests/integration/`
- Use Miniflare for Worker integration tests
- Critical paths require >90% coverage

### Prohibited Test Patterns

**Source-contract tests (`readFileSync` + `toContain()`) are NOT valid behavioral tests.** Reading a component's source code as a string and asserting substrings exist proves that code is *present*, not that it *works*. This pattern creates false confidence — tests pass while the feature is broken.

- Any component with user interactions (click handlers, navigation, form submission, state changes) MUST have tests that **render** the component and **simulate** those interactions.
- Source-contract tests may only be used for static configuration or structural verification (e.g., "does this config file export certain keys", "does this theme file define required tokens").
- When reviewing existing tests, if a test file uses `readFileSync` / `readSource` on a component with interactive behavior, flag it for migration to a behavioral test.

### Interactive Element Test Requirement

Every new button, link, form, or interactive element MUST ship with at least one behavioral test that:
1. **Renders** the component (using `render()` from a test framework)
2. **Simulates** the user interaction (click, submit, type, navigate)
3. **Asserts** the user-visible outcome (DOM change, navigation, displayed text)

A test that only checks the element exists in the DOM is insufficient. The test must exercise what happens when the user interacts with it.

## Regression Test Requirements (Mandatory for Bug Fixes)

When fixing a bug, you MUST write **two categories of tests**:

### 1. Tests That Prove the Fix Works

Standard tests that verify the new/corrected behavior functions as intended.

### 2. Tests That Would Have Caught the Regression

Ask: "What test, if it existed before the breaking change was introduced, would have failed and alerted us?" Write that test. This is the more important of the two.

- **Trace the regression to its root cause commit.** Understand exactly what change broke the behavior.
- **Write a test that exercises the contract that was violated.** Not just the symptom — the invariant that should always hold.
- **If mocks hid the bug**, the right response is often an integration or E2E test that uses real (or more realistic) dependencies. Shallow unit tests with overly permissive mocks can give false confidence.
- **If the bug was a missing propagation** (value set in A but never forwarded to B), write a test that constructs the real lifecycle (A then B) and asserts the value arrives.

### Evaluating Test Realism

Before finalizing tests, ask:
- Do these mocks accurately represent the real system? Would a broken invariant actually cause a test failure here?
- Is there a cross-component boundary that unit tests can't cover? If so, add an integration test.
- Would a developer introducing the original regression have seen a red CI from these tests? If not, the tests aren't defensive enough.

## Post-Mortem and Process Fix Requirements (Mandatory for Bug Fixes)

Every PR that fixes a bug MUST include a post-mortem and process improvement. Bug fixes without process fixes only fix the symptom — the class of bug will recur.

### 1. Post-Mortem (in `docs/notes/`)

Create a post-mortem file at `docs/notes/YYYY-MM-DD-<descriptive-name>-postmortem.md` covering:

1. **What broke**: Describe the user-visible failure
2. **Root cause**: Trace to the specific code change that introduced the bug
3. **Timeline**: When was the bug introduced, when was it discovered, what happened in between?
4. **Why it wasn't caught**: Analyze which practices failed — missing tests, wrong test type, insufficient review, missing trace, etc.
5. **Class of bug**: Generalize beyond this specific instance — what *category* of bug is this? (e.g., "state interaction race conditions", "mock-hidden integration failures", "aspirational documentation treated as fact")
6. **Process fix**: What changes to rules, checklists, agent instructions, or review procedures would prevent this *class* of bug in the future?

### 2. Process Fix (in the same PR)

The PR MUST include concrete changes to at least one of:
- `.claude/rules/` — agent guidelines and quality gates
- `.claude/agents/` — reviewer agent instructions
- `.github/pull_request_template.md` — PR checklist items
- `CLAUDE.md` — project-level instructions

The process fix must target the **class of bug**, not just the specific instance. Ask: "What rule, if it existed before this bug was introduced, would have prevented it?"

### 3. PR Description

The PR description must include a "Post-Mortem" section summarizing the root cause, the class of bug, and the process changes made. See the PR template for the required format.

## Pre-Merge PR Review (Required)

Before merging ANY pull request, dispatch a team of skeptical subagents to review the PR. Each reviewer should be adversarial — their job is to find problems, not confirm the code works.

### Review Team Composition

Dispatch reviewers **in parallel** covering each language and discipline touched by the PR:

| PR touches | Required reviewer agent |
|------------|----------------------|
| Go code (`packages/vm-agent/`) | `go-specialist` — concurrency, resource leaks, Go idioms |
| TypeScript API (`apps/api/`) | `cloudflare-specialist` — D1, KV, Workers patterns |
| UI code (`apps/web/`, `packages/ui/`) | `ui-ux-specialist` — accessibility, layout, interactions |
| Auth, credentials, tokens | `security-auditor` — credential safety, OWASP, JWT |
| Environment variables | `env-validator` — GH_ vs GITHUB_, deployment mapping |
| Documentation changes | `doc-sync-validator` — docs match code reality |
| Business logic, config | `constitution-validator` — no hardcoded values |
| Tests added/changed | `test-engineer` — coverage, realism, TDD compliance |

### What Reviewers Must Check

Each reviewer should:
1. **Read every changed file** in the PR diff
2. **Challenge assumptions** — what could go wrong? What edge cases are missed?
3. **Check test adequacy** — do the tests actually prove the fix/feature works, or are they too shallow?
4. **Verify data flow completeness** — for multi-component changes, trace the primary data path from input to output. Ask: "Does the data actually arrive at its destination?" (see `10-e2e-verification.md`)
5. **Identify missing tests** — what regression test would catch this if it broke again?
6. **Flag any concern**, even minor ones — it's cheaper to address them now

### Acting on Review Findings

- Fix ALL issues rated as bugs or correctness problems before merging
- Address style/improvement suggestions unless there's a clear reason to defer
- If a reviewer identifies a missing test category (e.g., "this needs an integration test, not just unit tests"), add it
- Push fixes and re-run reviewers if changes are substantial

## Post-Push CI Procedure (Required)

After every push, check GitHub Actions runs for the pushed commit/branch. If any workflow fails, inspect the failing job logs immediately and implement fixes. Push follow-up commits and repeat until all required workflows are green.

For pull requests, keep the PR template filled (including Agent Preflight block) so quality gates can pass.

## Post-Deployment Playwright Testing (Required)

After ANY deployment to production (push to main or merged PR), you MUST verify the deployed feature works using Playwright against the live app.

1. Wait for the Deploy workflow to complete successfully in GitHub Actions.
2. Use Playwright to navigate to `app.simple-agent-manager.org` and test the deployed feature end-to-end.
3. Use the test credentials stored at `/workspaces/.tmp/secure/demo-credentials.md` to authenticate. If the file is missing, ask the human for credentials.
4. If the feature cannot be tested via Playwright, document why and what was verified manually.
5. Report results to the user — do not assume deployment success just because CI passed.
