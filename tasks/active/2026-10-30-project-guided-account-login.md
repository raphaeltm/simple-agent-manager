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
- [x] Unit/contract tests and lint/typecheck/build
- [x] Mobile/desktop visual audit and independent specialist reviews
- [x] Staging scoped-flow verification and cleanup
- [ ] PR, CI, best-effort CodeRabbit, merge, production smoke

## Acceptance

Project Claude guided connection stores only project credential/pin without changing personal defaults; same capability for Codex through shared flow. Wrong-owner/missing/deleted project and conflicting active scope fail safely. Older APIs and API rollback cannot turn a project connection into a personal save. User flow remains compatible. Constitution describes installation/user/project/profile/skill composition, shared controls, scope/inheritance clarity and narrow justified exceptions without claiming every override is already implemented.

## Validation so far

56 backend focused cases and 16 frontend cases passed. Four Playwright cases passed for user/project form and modal at 375×667 and 1280×800, with 320px overflow assertions. Implementation and root agents inspected captured screenshots: changed dialogs have clear guided CTAs and readable scope text; no clipping. Existing underlying account-card warnings at 320px are outside this change. UI rubric: hierarchy 4, clarity 5, mobile 4, accessibility 4, consistency 5. Evidence: `tasks/evidence/2026-10-30-project-guided-login/`.

Independent security/Cloudflare/constitution and docs/completion reviews passed. Root lint/typecheck, API/web builds, file-size and context-budget checks passed; broad API/web suites passed before the final compatibility delta. No migration, bindings, secrets or new tunables.

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

## Live staging verification (2026-10-30)

Deployment41031118237 and smoke-tests passed on c471106ed3ba816771e22e48329f2a6e2d6a16f2. Cloudflare deployment2b4bdd6e-197b-4e0d-ae9e-350b853858a9 served Worker697424e0-86bc-4334-a88d-e16398b80f47 at100% with that commit annotation.

Authenticated live Playwright visited dashboard, projects and settings with no page errors. On project Test Project1, real Claude setup01M6672KHB26MSZ6X1RGEFZZ3R at375×667 and Codex setup01M66737SMMXR0PZEFRC0HHV6T at1280×800 both returned201 through /project, reached waiting_for_user with a provider sign-in link, rejected personal-scope reuse409 and cancelled successfully. D1 confirmed both rows scope=project, correct project_id, status=cancelled. Personal credential metadata was identical before/after; invalid project input returned400. No real provider approval or credential changes were performed.

Root inspected live mobile Claude form/modal and desktop Codex form screenshots: readable scope text and visible guided CTA, no clipping/overflow in changed dialogs. Safe captures and staging-result.json are committed under the evidence directory. The live Codex code-bearing modal capture is not published; mock captures cover that modal. Initial harness selector assumed an expanded account row; expanded the collapsed live row and reran without changing product code or creating any container in the initial attempt.

Fallback continuation was used: workflow event matched but prompt deliveryd52dc317-4519-4a9b-8c37-d911a74ad1be failed. The scheduled continuation arrived10:48UTC after09:33 due time; ignored tooling/state was absent after workspace rotation and was restored. No release gate was bypassed.

## CI scanner cleanup

The current-tree scan found one newly introduced synthetic AES key in the persistence test. Replaced the random-looking literal with Buffer.alloc(32,1).toString('base64'). The bounded PR-range scan still includes the earlier introduction commit, so an exact historical synthetic-fixture digest was independently reviewed and allowed until2026-11-07, without extending existing allowances or suppressing a rule/path. Raw scan reports stayed private and were deleted. Both current-tree and PR-range scans pass, and all12 native vertical tests pass after the test-only change. Independent scanner_delta_review passed; runtime code remains identical to stagedc471.

## Final static-analysis cleanup

Extracted request parsing/scope validation and agent resolution from the shared create handler to address Sonar S3776 complexity. All 60 focused backend tests, scoped lint, API typecheck and independent security/completion delta review pass. Validation/authorization/lease ordering and dedicated project endpoint behavior are unchanged. A fresh staging deployment and live cancel-only scope smoke are required before merge.

## CodeRabbit review fixes

Resolved both review findings: cancelled create continuations now return before writing the shared session ID; a deferred-response regression verifies current-project polling, code submission and cancellation after a stale response. Browser audit mocks configuration and session polling separately.45 focused unit tests,4 refreshed mobile/desktop browser cases, web typecheck/build/lint pass; screenshots inspected and independent security/completion delta review PASS.
