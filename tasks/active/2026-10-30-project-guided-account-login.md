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
- [x] Mixed-version safety: explicit config scope capability and dedicated project creation endpoint with no personal fallback
- [x] Shared guided UI for user/project Claude and Codex, correct success refresh
- [x] Constitution principle and relevant user/API docs
- [ ] Unit/contract tests and lint/typecheck/build
- [x] Mobile/desktop visual audit and independent specialist reviews
- [ ] Staging scoped-flow verification and cleanup
- [ ] PR, CI, best-effort CodeRabbit, merge, production smoke

## Acceptance

Project Claude guided connection stores only project credential/pin without changing personal defaults; same capability for Codex through shared flow. Wrong-owner/missing/deleted project and conflicting active scope fail safely. Older APIs and API rollback cannot turn a project connection into a personal save. User flow remains compatible. Constitution describes installation/user/project/profile/skill composition, shared controls, scope/inheritance clarity and narrow justified exceptions without claiming every override is already implemented.

## Validation so far

56 backend focused cases and 16 frontend cases passed. Four Playwright cases passed for user/project form and modal at 375×667 and 1280×800, with 320px overflow assertions. Implementation and root agents inspected captured screenshots: changed dialogs have clear guided CTAs and readable scope text; no clipping. Existing underlying account-card warnings at 320px are outside this change. UI rubric: hierarchy 4, clarity 5, mobile 4, accessibility 4, consistency 5. Evidence: `tasks/evidence/2026-10-30-project-guided-login/`.

Independent security/Cloudflare/constitution and docs/completion reviews passed. Root lint/typecheck, API/web builds, file-size and context-budget checks passed; broad API/web test suites running. No migration, bindings, secrets or new tunables.

## Post-mortem

Project account setup hid guided login because the original integration only supported user-scope creation; the later accounts UI retained that restriction. Tests covered each view but did not require capability parity across scope. This PR adds cross-scope UI/payload and real encrypted-storage vertical tests, and Constitution Principle XIV makes shared controls/capabilities across override layers a standing requirement.

## Release compatibility finding

Deployment publishes Web before API. The old creation endpoint stripped unknown
projectId, making a new UI/old API combination capable of starting personal login.
Config capabilities alone do not cover rollback after a browser caches capability.
The fix uses explicit project-scope advertisement plus a dedicated `/project`
creation endpoint sharing the same handler. Old APIs return 404; clients never
retry project creation against the personal endpoint. Initial staging08a was not
used to log in any provider account; redeploy the protected candidate before smoke.

Compatibility delta: security reviewer independently confirmed prior HIGH addressed. Final backend delta32 tests, frontend44 tests, API typecheck, web build, scoped lint and four refreshed guided browser cases passed. Prior broad suites14,300 API/4,795 web passed before the endpoint/capability delta; final PR CI will cover the complete candidate.
