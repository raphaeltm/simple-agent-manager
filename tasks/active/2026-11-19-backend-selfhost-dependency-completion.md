# Complete backend and self-host dependency PRs

SAM task: `01M7RJ316H7BABN9QTW6M3KMRH`.

## Problem and scope

Complete existing PRs #2891, #2892, #2893 and #2896 sequentially, preserving branches and history. Merge only after all applicable gates. An isolated major requiring coordinated migration may instead be closed with evidence and a preserved SAM idea. No force pushes, branch deletion, paid overage, resource-default changes or secrets readback in Actions.

## Research findings and preflight

- #2891: go-smtp 0.25.1 to 0.26.0. The GitHub compare view includes BDAT fixes already backported in immutable v0.25.1; direct downloaded-module diff confirms those are retained compatibility behavior, while v0.26.0 changes Postmaster parsing and moves DELIVERBY/MT-PRIORITY from RcptOptions to MailOptions. SAM enables neither extension and uses neither moved field (`deploy/selfhost/sam-mx/main.go:newServer`, `session.go`). Existing receiver harness uses real TCP SMTP and HTTP gateway boundaries with DNS fixtures. BDAT compatibility controls pass both versions; Postmaster reaches SAM rejection only on v0.26.0 (501 parser rejection before, 550 SAM rejection after). Verify accepted/rejected mail, repeat transactions and new BDAT behaviors under race/vet.
- #2892: runtime Alpine 3.22 to 3.24. Verify actual image compatibility with pinned libcap-utils and unprivileged port 25 before deciding.
- #2893: isolated builder Go 1.27.3 while module and repository require 1.26.11. Reconcile supported coordinated strategy and Sonar findings before deciding.
- #2896: client-s3 updated alone, presigner remains older. Reproduce strict type mismatch and align compatible SDK versions without casts; exercise presigning/artifact boundaries.
- Classification: external-api-change, security-sensitive-change, infra-change. Primary upstream source for #2891: GitHub emersion/go-smtp v0.25.1...v0.26.0 comparison. No new interfaces/configuration intended; search affected docs for version/behavior references before commits. Dependency pins and test fixtures introduce no new runtime knobs.
- Coordinate self-host box use with current owner; both staging leases must be checked before use. Fresh PR head/checks/comments/reviews/threads, all association pages, exact URL/branch owners and linked tasks required before editing each PR.

## Checklist and acceptance criteria

For each PR, independently:
- [ ] Reconcile fresh GitHub and SAM ownership/evidence.
- [ ] Validate compatibility and diagnose all failures; implement smallest complete fix or supported documented closure.
- [ ] Run applicable tests/build/race/vet and actual runtime verification; record totals and limitations.
- [ ] Complete independent domain/security/task-completion reviews and resolve findings.
- [ ] Request CodeRabbit on ready candidate and record result; all CI and Sonar gates pass.
- [ ] Complete applicable staging/self-host evidence with coordinated leases and cleanup.
- [ ] Verify final merged/closed GitHub state, preserve branch, monitor applicable deployment, update SAM ideas and maintenance.pr-shepherd.

PR completion:
- [ ] #2891
- [ ] #2892
- [ ] #2893
- [ ] #2896

References: `.agents/skills/do/SKILL.md`, rules 02/05/09/13/14/25, constitution principles II/X/XI/XII/XIII; `tasks/archive/2026-11-18-l21-smtp-sign-in-selfhost-inbound-email.md` for receiver flow and prior box evidence. Every checkbox requires concrete test/runtime/GitHub evidence before completion.

## #2891 evidence (in progress)

- Fresh original head 3233d51bba069b30605874d4f31d67a4374e9a93; no review threads, closing issues, other active owners or associations. Associated to this task; merged current main normally in original branch worktree.
- Existing receiver suite plus four new protocol tests: 39 pass under race detector, vet and binary build pass; Dockerfile build passes on original Go/Alpine pins.
- New controls: rejected chunk cannot issue QUIT, command limit restored between chunks, Postmaster still rejected by SAM, consecutive signed BDAT deliveries assert exact gateway bytes/auth identity.
- pnpm selfhost:test: 15 files / 212 tests pass. API dependency build: 12 tasks pass. Broader SMTP vertical tests and runtime checks pending.
- Both staging queues free 12:13Z. L22 released box; next claimant H2 contacted; no box mutation performed.
- Workflow task-only push to main rejected by required CI; task record carried in this PR rather than bypassing protection.
- No public docs reference the old dependency pin; no user-facing SAM interface/configuration changed.
- Remaining checklist items for other PRs intentionally pending sequential execution after #2891.
