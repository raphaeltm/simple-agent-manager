# Staging lease

SAM task: 01M7G56GV78W26KKVN45P8BTEJ; approved design 2026-11-15.

## Problem and research

Staging live checks outlive deployment jobs; no active run plus five minutes is not a release. Use the serialized deploy-staging workflow and GitHub deployment records filtered by environment and dedicated task. GitHub supports deployments: write on workflow tokens and payloads; prove live before merge. Existing permission guard must permit only the lease job's deployment writes. Other jobs, including audit-only paths, must depend on lease success. Reusable deploy and CI workflows belong to siblings.

## Checklist and acceptance

- [x] Lease decision and API script: missing/free, foreign active refusal, expiry takeover, self renewal; malformed/API errors fail closed.
- [x] Environment-keyed serialized workflow preflight with configurable expected deploy time, default/capped hold and optional SAM task ID.
- [x] Same-workflow holder-only release and acquire-only path for bounded checks without full redeploys.
- [x] Unit and integration tests; permission/gating verification.
- [x] Update staging docs, Codex skill summary, and full reference: read/acquire/release, expiry wake rather than chat/poll.
- [ ] Local specialist reviews and affected checks; full CI green.
- [ ] Live workflow-token/gh read proof, acquisition, refusal, renewal, release, expired takeover; one full staging deploy plus bounded lease-only checks; release after verification.
- [ ] PR and CodeRabbit gate, rebase shared docs, merge; add usage note to idea 01M7FYGMEESYH3AJZJ0CT3NKCZ and channel evidence.

References: .claude/rules/13-staging-verification.md and full reference; GitHub REST deployments documentation; idea notes read 2026-11-15. Existing isolated SAM branch used without a redundant worktree. Task tracked on this branch to avoid a separate main commit triggering unrelated pipelines.
