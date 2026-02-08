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
- [ ] E2E coverage added or explicitly justified as not applicable
- [ ] Local test run passes for impacted packages
- [ ] CI test checks are expected to pass with the changes

### Test Locations

- Unit tests: `tests/unit/` in each package
- Integration tests: `apps/api/tests/integration/`
- Use Miniflare for Worker integration tests
- Critical paths require >90% coverage

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
