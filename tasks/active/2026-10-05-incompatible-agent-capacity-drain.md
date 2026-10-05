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
- [ ] Implement admission-triggered bounded safe drain through existing sleep machinery; scope to managed same-user pool VM hosts with incompatible builds.
- [ ] Preserve busy work, blocked episodes, warm retention and DB cap; record version-specific drain evidence.
- [ ] Correct hardware/reserve rejection reasons while retaining true authority mismatch diagnostics.
- [ ] Real admission-path regression with occupied incompatible host; simulate bounded safe sleep/cleanup and verify subsequent provisioning.
- [ ] Eligible-full convergence and busy/blocked/foreign/deployment/Instant controls.
- [ ] Prove regression fails against original code and run required quality checks.
- [ ] Independent Cloudflare, constitution, test, documentation and completion review; resolve findings.
- [ ] Coordinate one pinned bounded staging sweep with visibility and telemetry siblings; clean resources.
- [ ] Archive task, draft PR, CI, CodeRabbit request/wait, merge and monitor production deploy.

## Acceptance
Admission actively progresses a safe incompatible host drain without increasing pool max or destroying active/unrecoverable work. Existing sleep episode and cleanup budgets bound reclaimable-host recovery. Full eligible hosts continue to wait/expire. Placement evidence identifies incompatible-agent drain and actual resource shortages. Real admission tests and staging evidence demonstrate behavior. Seven-day production recurrence observation is a follow-up SAM Idea, since this implementation run cannot observe a future week.

## Rules
Rules 47, 54, 62, 69, 74; `/do`, configured warm retention, canonical idleness and bounded sleep recovery policies.
