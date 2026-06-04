# Onboarding overlay: render instantly instead of after a 5-6s status fetch

## Problem

Visiting `https://app.simple-agent-manager.org/dashboard?onboarding` paints the
dashboard immediately, but the onboarding overlay only pops in 5-6 seconds
later, "out of nowhere". This is not a bundle/load-time issue — the app shell is
fast. The overlay's visibility is incorrectly gated on an async setup-status
fetch.

### Root cause

`apps/web/src/components/onboarding/OnboardingContext.tsx`:

- `showOverlay = overlayOpen && !dismissed && !loading` (the `!loading` gate).
- `loading` only flips to `false` in the `finally` block of `checkStatus()`,
  which `await`s `Promise.allSettled([listCredentials(), listGitHubInstallations(),
  listAgentCredentials()])`. `listGitHubInstallations()` (`GET /api/github/installations`)
  is the slow call (~5-6s).
- Worse, `overlayOpen` is only set to `true` *inside* that async `checkStatus()`
  — both for the `?onboarding` force-open path and the first-visit auto-show
  path. So even removing the `!loading` gate alone wouldn't make the forced
  overlay instant; the open signal itself is delayed by the fetch.

Net effect: the overlay cannot appear until all three credential endpoints
settle, even when the user explicitly asked for it via `?onboarding` or the
"Complete Setup" button.

## Research findings

- `ChoosePathWizard` (`apps/web/src/components/onboarding/choose-path/ChoosePathWizard.tsx`)
  is always mounted in `AppShell` and renders `null` when `!showOverlay`
  (line 182). It also has its OWN background `Promise.allSettled` fetch for tag
  pre-population (lines 88-124) — independent, does not gate rendering, left
  as-is.
- Context consumers:
  - `showOverlay`, `dismissOnboarding` → `ChoosePathWizard`
  - `needsOnboarding`, `openOnboarding` → `NavSidebar` "Complete Setup" button
    (`needsOnboarding = !setupComplete && !loading` — legitimately needs the
    fetch result; unchanged).
  - `loading` → exposed for tests.
- Existing tests: `apps/web/tests/unit/onboarding/OnboardingContext.test.tsx`
  (7 cases covering auto-open, auto-dismiss, inactive-agent, dismissed,
  `?onboarding` re-open paths). All must continue to pass.

## Fix

Decouple overlay *visibility* from the *status fetch*:

1. Compute the `?onboarding` force-open synchronously and use it to initialize
   `overlayOpen` (so a forced overlay is open on first paint).
2. Initialize `dismissed` to `false` when force-open is present (overrides a
   persisted dismissal), matching existing `?onboarding` behavior — without
   clearing the persisted localStorage flag.
3. Drop the `!loading` term from `showOverlay` → `showOverlay = overlayOpen && !dismissed`.
4. Keep the background `checkStatus()` fetch exactly for what genuinely needs
   it: setting `setupComplete`, auto-showing on first visit when setup is
   incomplete, and auto-dismissing when setup is complete (avoids a flash for
   already-complete users).
5. `needsOnboarding` (NavSidebar "Complete Setup") stays gated on `!loading` —
   it should not appear until we know setup is incomplete.

## Implementation checklist

- [ ] Add a synchronous `?onboarding` URL helper in `OnboardingContext.tsx`.
- [ ] Initialize `overlayOpen` from the helper.
- [ ] Initialize `dismissed` to `false` when forced.
- [ ] Change `showOverlay` to `overlayOpen && !dismissed` (remove `!loading`).
- [ ] Keep `checkStatus()` background-only (setupComplete / auto-show / auto-dismiss).
- [ ] Add a regression test: with `?onboarding` and a *pending* status fetch,
      the overlay is `open` while `loading` is still `loading` (proves the
      decoupling; would fail against the old `!loading` gate).
- [ ] Confirm all 7 existing OnboardingContext tests still pass.
- [ ] Playwright visual audit of the overlay (mobile 375 + desktop 1280).

## Acceptance criteria

- `?onboarding` shows the overlay on first paint, not after the credential
  fetch settles.
- The "Complete Setup" nav button still only appears once setup is known
  incomplete (no false flash).
- Already-complete users do not see a flash of the overlay.
- No regression in the 7 existing OnboardingContext tests.

## References

- `.claude/rules/06-technical-patterns.md` (React interaction-effect analysis)
- `.claude/rules/16-no-page-reload-on-mutation.md`
- `.claude/rules/17-ui-visual-testing.md`
