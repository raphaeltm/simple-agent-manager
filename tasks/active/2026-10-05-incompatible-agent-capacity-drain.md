# Drain incompatible agent nodes when capacity admission is blocked

SAM task: 01M473KXWJYT6S1JR03E8GVY2B. Idea: 01M4677451EBA2GZW0TENE0WEM.

## Problem
Six production tasks exhausted the two-hour admission deadline while an occupied incompatible-agent host held spare hardware capacity and a pool slot. Preserve active work and configured pool/account limits. No legacy workspace-count caps or quota/spend changes.

## Research
- Current main 0366b17d9 retains the defect; no open duplicate PR or active matching task found.
- `capacity-pool-node-limit.ts` and migration 0167 count managed running/creating/recovery nodes; placement exact agent-version gating rejects old builds.
- `node-provisioning-step.ts` checks the limit before and after the provisioning lease and handles the real trigger abort.
- Old-agent cleanup in `scheduled/node-cleanup/node-phases.ts` only retires empty hosts after configured idle retention; it never initiates drain.
- Merged #2218/#2223/#2224 fix snapshot size, bounded sleep (3 failures/15 minutes with verified recovery or blocked state), and callback renewal. Reuse these; do not modify sibling sleep-status/telemetry files.
- `queueWorkspaceSessionSleep` supports expected-node fencing and preserves attempts. Canonical sleep teardown independently checks authoritative idleness and durable recovery.
- Candidate resolution subtracts host memory reserve; early hardware diagnostic does not, masking resource shortage as allocation authority mismatch.
- Production read 2026-10-05: one running managed pool host, four occupied workspaces; historical incompatible nodes already deleted. Reproduce deterministically and on bounded staging fixtures.

## Checklist
- [x] Implement admission-triggered bounded safe drain through existing sleep machinery; scope to managed same-user pool VM hosts with incompatible builds.
- [x] Preserve busy work, blocked episodes, warm retention and DB cap; record version-specific drain evidence.
- [x] Correct hardware/reserve rejection reasons while retaining true authority mismatch diagnostics.
- [x] Real admission-path regression with occupied incompatible host; simulate bounded safe sleep/cleanup and verify subsequent provisioning.
- [x] Eligible-full convergence and busy/blocked/foreign/deployment/Instant controls.
- [ ] Prove regression fails against original code and run required quality checks.
- [ ] Independent Cloudflare, constitution, test, documentation and completion review; resolve findings.
- [ ] Coordinate one pinned bounded staging sweep with visibility and telemetry siblings; clean resources.
- [ ] Archive task, draft PR, CI, CodeRabbit request/wait, merge and monitor production deploy.

## Acceptance
Admission actively progresses a safe incompatible host drain without increasing pool max or destroying active/unrecoverable work. Existing sleep episode and cleanup budgets bound reclaimable-host recovery. Full eligible hosts continue to wait/expire. Placement evidence identifies incompatible-agent drain and actual resource shortages. Real admission tests and staging evidence demonstrate behavior. Seven-day production recurrence observation is a follow-up SAM Idea, since this implementation run cannot observe a future week.

## Rules
Rules 47, 54, 62, 69, 74; `/do`, configured warm retention, canonical idleness and bounded sleep recovery policies.

## Verification progress
- Reviewed implementation and tests: `65dfc2ca7f148cc08dd8de5bc0804828f22ee3a4`.
- Independent Cloudflare/constitution review PASS; queueable candidate status improvement addressed in `2290e2fbd`.
- Independent test-engineer review PASS; actual admission tests include schema-derived SQLite and migration 0167 trigger. Final focused run: 23/23 PASS. External snapshot and provider deletion receipts remain simulated locally and require staging evidence.
- Independent completion implementation review PASS; acceptance completion WARN pending staging/quality. LOW real retry status corrected to `failed` and `preparing` added in `65dfc2ca7`.
- Documentation review PASS; provenance restriction corrected in `65dfc2ca7`.
- Regression proof: deleting admission drain invocation fails missing snapshot assertion; removing memory/reserve diagnostic checks fails expected memory reason against authority mismatch. Both restored; final 23/23 PASS.
- Root lint 13/13 PASS and root typecheck 19/19 PASS. Full tests/build run serially to avoid memory contention.

## Shared staging fixture ledger
Coordinator: resource-history task `01M473KNZ9WXZ0X4G3Z743X2C1`; pinned integration `2e4e88645abef7b3eab347795e5d356918494147`, no independent deploy.
Approved estimate: two small hosts within shared window < EUR 0.10; actual cx23 EUR 0.0088/hour, no quota/spending increase.
Live staging rechecked zero managed runtimes before provisioning. Existing required agent build `c66d1dd51ef46a92b9e12c169cb3138d1d266550` confirmed in Worker settings and fixture heartbeat.
Owned project `01M4757VDW3YBG091THZCKNHGV`, first fixture task `01M4758TYJ6V233G85VSEHNT2K`, session `a15ffebd-4414-4ff2-8691-d5efe0817abd`, node `01M47592V5DFAXA2ARYJ2Y7PVF`.
Chat: https://app.sammy.party/projects/01M4757VDW3YBG091THZCKNHGV/chat/a15ffebd-4414-4ff2-8691-d5efe0817abd
Pool `cap-pool-default:user:toWzGjNW3IyUkCVItRQv3qSn0wI8c22y`; original maxNodes3. Reservation 625cpuMillis/1152memoryMb/13312diskMb.
Setup correction pending: lowering maxNodes1 before workspace admission completed advanced revision25->26; restoring ORIGINAL3 advanced27 and could not repair strict cached authority. First host remains healthy empty, no workspace created. Coordinator notified and asked to authorize sequential API cleanup/provider absence then ONE corrected fixture with maxNodes1 configured before submission. No further VM provisioned.

Seven-day recurrence follow-up SAM Idea: `01M474AV9DBFPBKPKAZ6PZXDTV` (future observation cannot be completed in implementation run).
