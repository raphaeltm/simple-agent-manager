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

## 3. Related: the sweep masks these failures

Worth investigating alongside. In the full-project sweep these same tests land in
the "did not run" bucket and the run exits **0**:

```
npx playwright test --project="iPhone SE (375x667)" --reporter=line
→ 29 skipped, 12 did not run, 666 passed   (exit 0)
```

but `--list` collects **782** tests for that project, so 782 − (666+29+12) = 75
are unaccounted for, and tests that fail in isolation are reported as
skipped/did-not-run in aggregate. That is a false-green risk: the sweep can go
green while specs are actually broken. `playwright.config.ts` sets no
`maxFailures` and no `globalTimeout`, and no spec uses `describe.serial`,
`test.only`, or `test.fixme`, so the cause is not obvious.

Note several `staging-*.spec.ts` files in that bucket talk to LIVE staging
(`app.sammy.party`) and throw if `SAM_PLAYWRIGHT_PRIMARY_USER` is unset — those
arguably should not be part of a default local sweep at all.

## Acceptance Criteria

- [ ] Decide the fate of `/sam`: delete it, or graduate it off the prototype path
- [ ] If kept: `sam-prototype-audit.spec.ts` passes on mobile and desktop
- [ ] If deleted: route removed from `App.tsx`, page deleted, spec deleted
- [ ] Prototype-route pre-merge check catches routes that do not use the
      `/prototype/` prefix (rule 37's checklist is prefix-specific today)
- [ ] Explain the 782-vs-707 sweep accounting gap; a spec that fails in isolation
      must not be reported as skipped/did-not-run with exit 0
- [ ] Decide whether live-staging specs belong in the default local sweep
