# Composer audit: "restored provisioning session" Playwright test fails on main

## Problem

`apps/web/tests/playwright/project-chat-composer-audit.spec.ts` › "restored provisioning session shows staged progress without overflow" fails on `main` (c0fb8edd8) at both 375×667 and 1280×800:

```
Locator: getByText('Installing dependencies (3/4)')
Expected: visible
Error: element(s) not found
```

The page renders the mocked session as "Running" with its messages and a "Reconnecting..." alert, but no provisioning progress block. Either the progress UI no longer renders for a restored `queued` task with `executionStep: 'workspace_ready'`, or the spec's mocks no longer match how the page loads provisioning state.

## Context

Found on 2026-10-21 while running the composer audit for the new-chat profile picker (branch `sam/new-chat-profile-picker`). Reproduced with `main`'s `apps/web` checked out, so it is unrelated to that branch.

Repro: `cd apps/web && npx playwright test tests/playwright/project-chat-composer-audit.spec.ts -g "restored provisioning" --project="Desktop (1280x800)"`.

## Acceptance criteria

- [ ] Find whether the product regressed (restored provisioning sessions no longer show staged progress) or the spec's mocks drifted.
- [ ] If the product regressed, fix it and add a unit test through the real restore path.
- [ ] If the mocks drifted, update the spec to drive the real data path the page uses today.
- [ ] The test passes at 375×667 and 1280×800.
