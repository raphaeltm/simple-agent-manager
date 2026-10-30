# Guided account connection across scopes

## Problem

Project account setup only accepts pasted tokens although user account setup supports guided Claude/Codex login. Enable the same connection flow and preserve scope; document consistent UX across override layers in the constitution.

## Research

- #2473 repaired guided Claude login; #2474 preserved pre-existing user-only gate.
- Trigger hides project scope; create route hardcodes user; DO/save helper already carry project_id.
- Authorize project ownership at start and before asynchronous save; prevent resuming a different scope's active session.
- Existing SAM workspace/output branch reused for implementation; task tracked here rather than unrelated direct main commit.

## Checklist

- [x] Scope-aware validated API/create/save path and authorization regressions
- [x] Shared guided UI for user/project Claude and Codex, correct success refresh
- [x] Constitution principle and relevant user/API docs
- [ ] Unit/contract tests and lint/typecheck/build
- [x] Mobile/desktop visual audit and independent specialist reviews
- [ ] Staging scoped-flow verification and cleanup
- [ ] PR, CI, best-effort CodeRabbit, merge, production smoke

## Acceptance

Project Claude guided connection stores only project credential/pin without changing personal defaults; same capability for Codex through shared flow. Wrong-owner/missing/deleted project and conflicting active scope fail safely. User flow remains compatible. Constitution describes installation/user/project/profile/skill composition, shared controls, scope/inheritance clarity and narrow justified exceptions without claiming every override is already implemented.

## Validation so far

56 backend focused cases and 16 frontend cases passed. Four Playwright cases passed for user/project form and modal at 375×667 and 1280×800, with 320px overflow assertions. Implementation and root agents inspected captured screenshots: changed dialogs have clear guided CTAs and readable scope text; no clipping. Existing underlying account-card warnings at 320px are outside this change. UI rubric: hierarchy 4, clarity 5, mobile 4, accessibility 4, consistency 5. Evidence: `tasks/evidence/2026-10-30-project-guided-login/`.

Independent security/Cloudflare/constitution and docs/completion reviews passed. Root lint/typecheck, API/web builds, file-size and context-budget checks passed; broad API/web test suites running. No migration, bindings, secrets or new tunables.

## Post-mortem

Project account setup hid guided login because the original integration only supported user-scope creation; the later accounts UI retained that restriction. Tests covered each view but did not require capability parity across scope. This PR adds cross-scope UI/payload and real encrypted-storage vertical tests, and Constitution Principle XIV makes shared controls/capabilities across override layers a standing requirement.
