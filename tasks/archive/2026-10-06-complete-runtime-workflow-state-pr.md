# Complete runtime workflow state PR #2227

## Problem and scope

Complete the existing draft PR without changing its intent: make `.do-state.md` and `.workflow-state.md` visible to Git-based session snapshots while keeping them out of commits. Merge only after quality, Sonar, specialist review, and best-effort CodeRabbit gates are complete. The original PR body records the workflow-loss incident.

## Research

- `check:fast` gained a guard but CI lint steps and `ci-quality-program.test.ts` did not: quality job failed its wiring contract.
- Sonar `typescript:S2871` flagged the guard's default string sort.
- Specialist evidence had a `PENDING` placeholder.
- Workflow guidance still described state as gitignored.
- Standalone snapshot capture uses `git add -A` with a temporary index (`session_snapshot_wip.go`); container capture mirrors that contract (`session_snapshot_container_wip.go`). Both restore worktree and saved index separately. Removing ignore entries includes ordinary-sized local state without tracking it.
- The original guard missed nested paths and rejected staged deletions; fresh Sonar analysis later flagged inherited PATH lookup (S4036). A configurable absolute executable preserves portability while removing that lookup.

## Implementation and acceptance

- [x] Wire the guard into blocking CI lint and update its contract test.
- [x] Supply explicit string comparator for Sonar.
- [x] Cover root and nested runtime paths; reject tracking/staging and allow staged removal.
- [x] Use an absolute Git executable with documented SAM_GIT_BINARY override; reject relative overrides and fail closed when Git fails.
- [x] Update both agent workflow instructions to describe local-only, snapshot-visible state.
- [x] Add real-Git tests for snapshot tree capture/restore, tracking/staging rejection, removal, and Git failure.
- [x] Validate types, build, 655 quality tests and existing Go snapshot regressions; format ratchet passed. Blocking lint/CI remains recorded in PR evidence.
- [x] Complete independent specialist reviews and record findings/evidence in PR.

## Release gates (canonical record: PR body)

Ready the PR only after validation; request CodeRabbit and complete its wait. Merge only after required checks pass, then monitor production deployment. These operational steps are tracked in PR evidence rather than claimed complete by this implementation archive.

## Staging decision

No deployable API, web, or VM-agent source changes. Local tests exercise the changed repository Git visibility and quality-script behavior, and existing Go snapshot tests cover capture/restore mechanics. Under the user's instruction to stage only if needed and staging is free, no staging deployment is needed for this patch.

## Evidence

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2227
Local and CI results, specialist reports, and CodeRabbit outcome are recorded in the PR body. Workflow state remains local and is never included in commits.

Validated on 2026-10-06: `check:fast` passed, typecheck passed 19 tasks, build passed 9 tasks, quality scripts passed 655 tests, and existing Go snapshot regressions passed. Independent reviewers passed the snapshot/constitution and completion/docs/tests reviews. GitHub CI run 37505740686 passed; final Sonar and CodeRabbit release evidence is maintained in the PR.

Validated on 2026-10-07: fresh Sonar analysis cleared S2871 and exposed S4036. Fixed executable selection without suppression. Security/constitution/doc review passed; focused suites passed16 tests, ESLint and runtime-state guard passed. Current-head CI and Sonar remain release gates in the PR body.
