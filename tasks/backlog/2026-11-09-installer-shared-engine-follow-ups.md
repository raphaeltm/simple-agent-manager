# Installer: open follow-ups carried from the archived full-installer task

## Problem

The user-owned installer shipped in #2475 (merged 2026-11-08). The task file that drove it,
`tasks/archive/2026-10-28-full-installer.md`, still had unchecked items when the 2026-11-09
weekly reconciliation archived it. This file carries the ones still plausibly open, so they are
not lost in the archive. Nothing here was re-verified in that sweep: check each item against
current `main` before working on it.

## Context

- SAM's own production deploy still runs with `use_shared_engine` unset
  (`.github/workflows/deploy-reusable.yml`), so every shared-engine step is skipped there. The
  "Shared engine / existing CI parity audit (2026-10-28)" section of the archived file lists
  what the engine must preserve before CI can switch to it (workflow_call inputs, resource and
  state inputs, the Worker config and secret mappings, Docker runner differences, deploy-warning
  validation, GitHub-only reporting, and a staging equivalence qualification).
- The archived file's "Adversarial completion audit" section lists four functional gaps:
  rejecting older or incompatible releases before update approval; preserving verified canonical
  source in the user's account; enforcing the approved workers.dev target on resume and update;
  verifying API release identity and web availability before reporting completion.
- #2475's release dependencies (production `OAUTH_REGISTRATION_TOKEN`, `INSTALLER_MODE=full`,
  `INSTALLER_ARTIFACT_BASE_URL`, first Create Release dispatch) are operator steps. Raphaël runs
  the first production install himself.
- Related: `tasks/backlog/2026-11-06-installer-smoke-real-consent-scopes-and-flakes.md`.

## Acceptance Criteria

- [ ] Each adversarial-audit gap is confirmed fixed on `main` (cite the code path) or fixed.
- [ ] Decide whether SAM's own CI should switch to the shared engine. If yes, complete the parity
      audit items and qualify equivalence on staging first. If no, record the decision here.
- [ ] #2475's release dependencies are confirmed in place, or their absence is reported.
