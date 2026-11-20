# M6: merge main b1ebe0314 into sam/selfhost-pass-2

Task 01M7XKDJFD7GV1KSAEGY1ZV8H6, dispatched by coordinator 01M7XCE59V5X0WTNF1X3NFZP5J.
PR #2956, base `sam/selfhost-pass-2`. The coordinator merges it.

## Problem

Main is 121 commits past the M5 merge base (`114e1d98b`). Since M5, main has landed these
self-host slices:

- L22a/b/c: celld build and deploy, box runtime
- H2: hosted git
- L23: egress fence
- L24: backup, restore, upgrade, adoption
- sealed secrets
- key rotation

The integration branch must take main's version of everything that landed and keep only
what has not landed.

## Research findings

- `git diff 114e1d98b 2f61cea9a` is the branch's unlanded remainder as of M5. Each conflict
  was judged against it.
- L23 (`860718dc3`) precedes H2 (`c8f84a8e5`) on main's first-parent history, so L23 is
  merged first.
- Main relocated hosted git to `apps/api/src/selfhost/hosted-git/`, behind the artifacts
  seam. The branch's old-location copies are superseded.
- Main's #2900 (`node-operator-deletion.ts`) supersedes the branch's
  `node-operator-retirement.ts` (2cb2cbd86).
- Main refuses `importUrl`. The branch's importer is unbounded (H2 security review).
- Guided login on celld is unlanded, and its wiring lived in L22/L23 files main now owns.
  Coordinator decision: keep it unwired; idea 01M7XMTJAQG7P9R6FGQGY47R6C.

## Checklist

- [x] Stage 1 L22 `917077fef` → `2d2ec53b4`
- [x] Stage 2 L23 `860718dc3` → `4abfff33b`
- [x] Stage 3 H2 `c8f84a8e5` → `67cb93d78`
- [x] Stage 4 L24 `51a2bd14d` → `efb4cdc2b`
- [x] Stage 5 sealed `77572b69e` → `cf52d4d9b`
- [x] Stage 6 rotation `b1ebe0314` → `9d11f2076`
- [x] Migrations and wrangler.toml identical to main
- [x] Shared crypto/auth files byte-identical to main
- [x] Ideas filed: guided-login re-port (01M7XMTJAQG7P9R6FGQGY47R6C), bounded importer
      (01M7XMTPYXEW7MMG8YSW6X99M4)
- [ ] Post-merge fixes: build, typecheck, lint, tests
- [ ] Reviews: architecture-reviewer, security-auditor, task-completion-validator
- [ ] Dispatched CI green, including Self-host Live (Docker)
- [ ] CodeRabbit requested and waited for

## Acceptance criteria

- Real merges only: no rebase, no cherry-pick, no force-push to the integration branch.
- Landed code is identical to main, apart from the unlanded remainder listed in the PR.
- Full CI is green on the PR head.
- Every reviewer is PASS or ADDRESSED.
