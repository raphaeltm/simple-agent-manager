# Restore sleeping sessions to the exact saved Git state

## Problem

A sleeping session can restore its HOME and harness state while silently resuming in the wrong repository checkout. The observed session saved clean commit `f967ae394bed2c21f100f6cad23e3a2897caf65a` on `sam/new-ui-resources-being-qd7mnj`, but recovery provisioned a checkout from `main` at `be80ba3fe6842cdb298cef7b0d0c67a88b27c814`. Capture skipped a WIP bundle because `git status` was clean, and restore never enforced the saved `BaseCommit` without that bundle.

## Preflight

Change classes: `cross-component-change`, `business-logic-change`, and `infra-change`.

The affected data flow is:

1. `packages/vm-agent/internal/server/session_snapshot_{archive,container,capture}.go` inspects the repository, creates any compact Git artifact, and writes Git metadata into the manifest.
2. `apps/api/src/routes/workspaces/session-snapshots.ts` validates the manifest; `session-snapshot-persistence.ts` stores the manifest in R2 and the base commit in D1.
3. `apps/api/src/services/session-recovery.ts` starts a recovery TaskRunner; `workspace-steps.ts` selects checkout/base branches for workspace provisioning.
4. `packages/vm-agent/internal/bootstrap/bootstrap.go` clones the base branch and selects the checkout branch.
5. `packages/vm-agent/internal/server/session_snapshot.go` downloads the saved artifacts, restores Git and HOME state, resumes the harness, and only then reports `restored`.

Assumptions and compatibility decisions:

- Git branch, upstream, remote, and detached-HEAD metadata can be added as optional manifest v1 fields, preserving old snapshots.
- Clean status does not prove recoverability. Snapshot capture preserves the saved commit graph in a Git bundle even for clean remotely reachable commits, avoiding capture-time network access and stale-remote assumptions.
- Existing snapshots with only `BaseCommit` remain restorable; missing new metadata falls back to exact base-commit restoration and validation without branch/ref reconstruction.
- The existing restore error path already records a visible `degraded` result, so a Git-state mismatch must return an error through that path rather than introduce a second terminal-state system.
- Public sleep/snapshot documentation must describe exact Git checkout preservation, clean local-only commits, explicit mismatch degradation, and repository bundle budget use.

Constitution alignment: the change adds no URLs, timeouts, limits, or environment-specific identifiers. Git operations use the existing request context and configured repository remote.

## Research findings

- Both standalone and container capture return early on an empty porcelain status, although `BaseCommit` is still recorded.
- Both restore paths use `BaseCommit` only while applying a downloaded WIP bundle. A clean snapshot never checks out or validates the commit.
- Existing two-ref WIP bundles contain synthetic worktree/index commits parented by saved `HEAD`; forcing this compact bundle for local-only clean commits preserves the commit graph without a filesystem snapshot.
- `restoreSessionSnapshot` reports `restored` after harness resume without a final repository HEAD check.
- `createCheckoutBranch` always uses `git checkout -b`, so a clone from `main` recreates an existing remote task branch from the wrong base.
- The API manifest validator mirrors the Go manifest field-for-field and accepts reproducible additive Git metadata while rejecting ref state a fresh canonical clone cannot recreate.
- Existing Git snapshot tests exercise real repositories and are the correct regression seam; workspace branch dispatch already has a focused bootstrap helper test seam.
- Relevant prior incident lessons require exact terminal verdicts, real trigger coverage, and fresh-node staging for VM-agent changes.

## Implementation checklist

- [x] Capture optional branch, upstream, remote, and detached-HEAD metadata in standalone and container snapshots.
- [x] Create/upload a Git bundle for clean worktrees so local-only commits and stale or unavailable remote state cannot make the saved `HEAD` unrecoverable.
- [x] Restore the exact saved commit and branch/detached state before applying WIP for standalone and container runtimes.
- [x] Validate actual `HEAD` against saved `BaseCommit` before reporting `restored`; route any mismatch through the existing degraded recovery result.
- [x] Prefer an existing remote checkout branch during bootstrap instead of recreating it from the clone base.
- [x] Extend the API manifest contract for additive Git metadata.
- [x] Update public sleep/snapshot documentation for the exact Git-state durability contract and bundle budget behavior.
- [x] Add discriminating regression coverage for remote clean commit restore, clean local-only commit bundling/restore, dirty restore ordering/effect, mismatch failure, and existing remote branch checkout.
- [x] Run focused Go/API tests, full local quality gates, specialist reviews, and task completion validation.
- [x] Deploy to staging, provision a fresh VM, verify heartbeat/access and a real sleep/wake exact-HEAD flow, then clean up.
- [ ] Open the PR with the referenced failure, before/after behavior, tests, staging evidence, and reviewer evidence; complete CI and CodeRabbit gates.

## Acceptance criteria

- [x] A clean worktree on a remote task commit wakes at the saved commit when the recovery workspace was provisioned from main.
- [x] A clean worktree with local-only commits captures a bundle and wakes with those commits intact.
- [x] A dirty worktree first restores saved `HEAD`, then restores its index/worktree state.
- [x] Restore cannot return or report `restored` when actual `HEAD` differs from saved `BaseCommit`.
- [x] A recovery checkout uses an existing remote task branch rather than recreating it from main.
- [x] The referenced session would restore to `f967ae394bed2c21f100f6cad23e3a2897caf65a` or report explicit degradation, never silent success on `be80ba3fe6842cdb298cef7b0d0c67a88b27c814`.

## References

- SAM Idea `01M30PPM0B96G2RM1HC4Q7EHG6`
- Session `b4eae631-4a46-4b1e-b89d-3d85224eccb7`
- Task `01M304HV194SGTNM44B25TMDVP`
- Original prototype commit `f967ae394bed2c21f100f6cad23e3a2897caf65a`
- `tasks/archive/2026-07-11-runtime-neutral-session-hibernate-wake.md`
- `tasks/active/2026-07-21-instant-runtime-recovery-state-machine.md`
- `tasks/active/2026-08-19-ensure-branch-exists-before-instant-workspace.md`

## Implementation notes

- New snapshots retain `baseCommit` plus optional `git` metadata (`branch`, `upstream`, `remote`, `detached`) without changing the manifest version; old manifests remain accepted.
- Clean capture now preserves the commit graph without consulting repository-controlled remotes. Dirty capture keeps the existing worktree/index bundle and treats exact-HEAD restoration as a prerequisite.
- Bundle restore imports objects first, checks out the saved commit/ref, materializes worktree/index state, and validates `HEAD` again before harness resume can report `restored`.
- Bootstrap checks `refs/remotes/origin/<checkout>` and tracks it when present; only genuinely new output branches are created from the requested clone base.
- Focused validation: VM-agent server/bootstrap tests pass with Go 1.26.6; API snapshot route has 19 passing tests; real Worker D1/R2 wiring has 2 passing tests; API typecheck and lint pass.
- Full validation: repository lint, typecheck, test, and build pass; all VM-agent Go tests and vet pass; focused race tests pass. Security, Go, Cloudflare, constitution, test, and documentation reviewers report no remaining findings.
- Staging deployment run `35552023220` passed at exact commit `870c1401ed0d8b90118acc7121af3845bc4a52d7`. A fresh full VM workspace created clean, unpushed commit `f8ddfb44e71390edf7d0b4c012c4bf104a6c9273` on `sam/staging-snapshot-verification-repository-adj6sy`; capture persisted matching branch/upstream metadata and a 23,255-byte Git bundle. Recovery provisioned replacement workspace `01M30YVZKEC2WCPZH2YCMZ9W9J`, reported both snapshot restore and recovery status `restored`, and the resumed agent verified the exact saved SHA, branch, and clean status. Authenticated dashboard, project, and settings pages returned 200 with no browser console errors. Staging cleanup finished with zero nodes.
- The staging run also exposed a separate pre-existing delivery timing defect: `workspace_deletion_unconfirmed` was classified terminal before deletion proof arrived. It is tracked as SAM Idea `01M30Z8PB7R3YXTX90BRG1KW0N`; a fresh delivery after proof existed created exactly one recovery task and completed the restore above.
- The mandatory task-completion validator passed checks A-F with no blocking or advisory gaps.
