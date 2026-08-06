# chat-file-viewer-audit Playwright spec is broken on main

## Problem

`apps/web/tests/playwright/chat-file-viewer-audit.spec.ts` fails **15 of 20 tests** on `main`
(verified at commit `b00dac03c`, 2026-08-04). Every failure is the same locator timeout:

```
expect(locator).toBeVisible() failed
Locator: locator('[aria-label="Show session details"]')
Expected: visible   Timeout: 3000ms
Error: element(s) not found
```

Affected tests: session header with Files/Git buttons (active workspace), file browser with entries /
empty directory / error state, git status with changes / no changes, diff view with changes, file
browser slide-over, git status slide-over, search with results / no matches / long paths.

## Context

Discovered while running the Playwright suite for the auto-run HTML artifact preview work
(`tasks/active/2026-08-04-auto-run-html-artifact-preview.md`). It is **not** caused by that change —
the spec was independently confirmed failing at `origin/main` with the preview work absent, and the
failure counts match exactly (15 per viewport).

The `[aria-label="Show session details"]` control appears to have been renamed, removed, or made
conditional in the session header without the spec being updated. Since the spec's helper gates on
that locator before doing anything else, the whole file fails early — which is why the Files/Git,
diff, and search assertions never run.

## Acceptance Criteria

- [ ] Determine whether the session-details control was renamed/removed, or whether the spec's mock
      state no longer satisfies the condition that renders it.
- [ ] If the control moved: update the spec's locator to the current accessible name.
- [ ] If the control is genuinely missing from the session header: decide whether that is itself a
      product regression, and file/fix accordingly rather than just relaxing the test.
- [ ] `npx playwright test tests/playwright/chat-file-viewer-audit.spec.ts` passes at both
      375x667 and 1280x800.
- [ ] Confirm the file browser / git status / diff / search assertions actually execute once the
      early gate passes — they have been dormant for as long as this has been broken.

## Notes

Use the JSON reporter to count results; the line reporter's non-TTY summary omits the failed count
(see the `AgentBehavior` knowledge entry on Playwright reporting):

```bash
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/x.json npx playwright test <spec> --reporter=json
```
