# Project chat recoverable-error banner does not render ("Agent error:" missing)

## Problem

`apps/web/tests/playwright/project-chat-recoverable-error-audit.spec.ts:179`
("renders recoverable error guidance and keeps the composer enabled") fails on
the `iPhone SE (375x667)` project:

```
Error: expect(locator).toBeVisible() failed
Error: element(s) not found
> 184 |     await expect(page.getByText('Agent error:')).toBeVisible();
```

The recoverable-error banner the spec expects is not present in the rendered
chat, so the user is not shown the "You can send another message to retry"
guidance for a recoverable agent error.

## Context

Discovered on 2026-08-11 while running the full Playwright suite during the
trigger-page mobile-overflow work (branch `sam/see-trigger-page-goes-06qjzh`).

**Confirmed pre-existing, not caused by that branch.** Verified by checking out
`apps/web` and `packages/ui` at `311758585` (the branch point), rebuilding, and
re-running the spec — it fails identically on the untouched baseline.

## Investigation Notes

- The spec's other cases in the same file were not individually triaged; only
  the one at line 179 was observed failing.
- Unknown whether the regression is in the banner component, the condition that
  decides an error is "recoverable", or the spec's mock payload drifting from
  the current session/message shape. Start by diffing the spec's mocked error
  payload against what the chat currently expects.

## Acceptance Criteria

- [ ] Root cause identified (component, recoverability predicate, or stale mock)
- [ ] If a product bug: the recoverable-error banner renders with the retry
      guidance and the composer stays enabled
- [ ] If a stale test: the spec is updated to the current contract AND a
      behavioral assertion still proves the user-visible guidance appears
- [ ] `npx playwright test project-chat-recoverable` passes on all viewports
- [ ] Post-mortem: why did this go unnoticed — is this spec running in CI?
