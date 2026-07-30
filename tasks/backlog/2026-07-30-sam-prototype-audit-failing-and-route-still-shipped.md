# sam-prototype-audit fails, and the /sam prototype route is still in the production app

**Discovered**: 2026-07-30, while running the full Playwright sweep to validate an
unrelated design-system change (trigger button feedback, branch
`sam/buttons-trigger-page-using-6b0nww`).

**Status**: pre-existing — NOT caused by that branch. Verified by running the same
spec in a clean worktree at `387ab7c58` (the branch point) and getting an
identical failure.

## Problem

Two separate issues, both centred on `apps/web/src/pages/SamPrototype.tsx`.

### 1. `sam-prototype-audit.spec.ts` fails: 8 failed, 6 skipped

```
npx playwright test sam-prototype-audit --project="iPhone SE (375x667)"
→ 8 failed, 6 skipped
```

First failure:

```
tests/playwright/sam-prototype-audit.spec.ts:238
  expect(locator).toBeVisible() failed
  Locator: locator('textarea[placeholder="Ask SAM anything..."]')
  Expected: visible
  Error:    element(s) not found
```

The placeholder string still exists (`SamPrototype.tsx:208`) but is behind a
ternary, so the rendered placeholder is presumably the other branch. The route is
still registered (`App.tsx:144`). Needs a look at what `openSam()` lands on now.

### 2. The prototype route is shipped in the production app surface

`.claude/rules/37-prototype-development.md` and the project policy
"Prototype artifacts are not production deliverables by default" both say
prototype-only routes must be removed before merging to main. The rule's own
pre-merge checklist is explicit:

> Before merging ANY PR to main:
> - [ ] All `/prototype/*` routes removed from `App.tsx`
> - [ ] All prototype page directories deleted

`/sam` (`App.tsx:144` → `SamPrototype.tsx`) is on `main` today. It does not use
the `/prototype/` prefix the rule expects, which is probably why it escaped the
check. Last touched by #1014 ("conversational onboarding in SAM chat with
interactive cards") and #824.

Decision needed from Raphaël: is `/sam` still a live prototype worth keeping, has
it graduated into a real product surface (in which case it needs a non-prototype
name, real data, and its audit fixed), or should it be deleted?

## 3. Scale: 74 of 782 visual-audit tests fail on `main`

A full single-project sweep on the unmodified branch point gives, via the **JSON**
reporter (authoritative):

```
expected: 667   unexpected: 74   skipped: 41   total: 782
```

All 74 were confirmed pre-existing by running the same specs in a clean worktree
at `387ab7c58` and getting **identical per-file failure counts**:

| Count | Spec | Verified pre-existing |
|------:|------|-----------------------|
| 17 | `knowledge-ui-audit` | identical on baseline |
| 15 | `chat-file-viewer-audit` | identical on baseline |
|  8 | `ai-usage-audit` | identical on baseline |
|  8 | `sam-prototype-audit` | identical on baseline |
|  4 | `deployment-settings-audit` | identical on baseline |
|  4 | `recent-chats-dropdown-audit` | identical on baseline |
|  4 | `report-issue-audit` | identical on baseline |
|  2 | `portal-overlay-audit` | identical on baseline |
|  2 | `settings-infomaniak-credential-audit` | identical on baseline |
|  1 each | `nested-session-sidebar`, `scaling-settings`, `settings-hetzner-validation`, `trial-chat-gate`, `trial-ui` | identical on baseline |
|  5 | `staging-*` (library-search 2, ai-proxy, codex-connect, file-preview-v2) | load LIVE staging, so local code is not involved |

CI does not block on any of this by design — `ci.yml`'s `playwright-visual` job is
`continue-on-error: true` and its own comments call the audits "informational".
So this is a known, accepted state rather than a new break. The question for
triage is whether 74 permanently-red audits are still earning their keep, or
should be fixed/deleted so the suite means something again.

## 4. Trap: a piped line-reporter summary hides the failure count

This cost real time and produced two incorrect "0 failures" reports during the
investigation. Three separate hazards, all avoidable:

1. **The summary block omits the failed count when captured from a non-TTY.**
   The captured tail reads `29 skipped / 12 did not run / 667 passed` with no
   failed line, because the line reporter emits `[1A[2K` cursor-up/erase
   sequences that corrupt the captured text. The failures *are* in the body
   (175 markers, 17 numbered blocks) — just not in the summary.
2. **`grep` silently matches nothing** on that output unless given `-a`; it
   treats the ANSI-laden stream as binary. `grep -c "Error:"` returns nothing
   rather than a count, which reads like "no errors".
3. **Piping loses Playwright's exit code.** `playwright test ... | grep ...`
   yields grep's status. Playwright exited **1**; the pipeline reported 0.

Recommended practice for agents verifying UI changes: use
`PLAYWRIGHT_JSON_OUTPUT_NAME=… --reporter=json` and count statuses from the JSON,
or at minimum `grep -a` and check `${PIPESTATUS[0]}`. Never conclude "0 failures"
from a piped line-reporter tail.

## Acceptance Criteria

- [ ] Decide the fate of `/sam`: delete it, or graduate it off the prototype path
- [ ] If kept: `sam-prototype-audit.spec.ts` passes on mobile and desktop
- [ ] If deleted: route removed from `App.tsx`, page deleted, spec deleted
- [ ] Prototype-route pre-merge check catches routes that do not use the
      `/prototype/` prefix (rule 37's checklist is prefix-specific today)
- [ ] Decide whether 74 permanently-red visual audits should be fixed or deleted
      (they are `continue-on-error` in CI today, so they signal nothing)
- [ ] Decide whether live-staging specs belong in the default local sweep
- [ ] Consider switching the default reporter, or documenting the JSON-reporter
      recipe, so a piped summary cannot read as green (see section 4)
