# Restore progress in the automatic session sleep queue

## Problem
Ten orphan snapshot sleep intents occupy every scheduler batch indefinitely. Valid idle workspaces remain running overnight. The prior diagnostic response also ended mid-sentence after task completion; investigate without assuming the scheduler killed it.

## Evidence and scope
- Parent task `01M1ZXM2SB61VTRA26AYJ24VPH`, session `3ce9fcf8-f2b6-4fed-a9db-e34894ce746a`; full findings survive in completion summary. No prior implementation.
- Production D1 September 8: orphan failed intents have NULL deadlines and attempts 0/1. `session-sleep.ts` marks them failed/NULL again, so LIMIT 10 repeatedly selects them.
- Existing `terminal_failed` sleep status already excludes impossible stopped captures. Preserve snapshot artifact/capture/recovery fields while terminalizing only obsolete sleep intent, with a concurrency fence.
- Parent D1 task mode is `task` despite user reporting conversation selection; final tokens follow completion; workspace still running. Investigate runtime/session evidence before attributing cutoff.
- Legacy stuck node `01M1RKXS5YT0AEAD84872MNN2E` lacks credential fingerprint. PR #2030 owns node-pool work but does not include the missing fingerprint recovery; track the gap without weakening strict provider ownership.

## Checklist
- [x] Add discriminating repeated-sweep/batch-saturation tests for missing source and missing metadata.
- [x] Terminalize impossible intent with a CAS fence; preserve artifacts and concurrent recovery.
- [x] Check budget exhaustion and repairable degraded candidate convergence.
- [x] Diagnose cutoff/mode mismatch and document evidence or tracked follow-up.
- [x] Confirm existing safe legacy-node remediation coverage or track required gap.
- [ ] Run appropriate unit/integration, lint, typecheck, build and local specialist review.
- [ ] Stage final candidate, create PR, pass CI/CodeRabbit, merge and verify production queue progress.

## Acceptance criteria
A full batch of permanently invalid candidates cannot block subsequent valid work across repeated ticks. Null/deleted sources leave retry eligibility without losing artifacts. Concurrent renewal cannot be overwritten by stale terminalization. Active prompts remain protected by the existing idleness predicate. Final report accurately separates demonstrated causes from unknowns.

## References
`.claude/rules/47-control-loop-io-budget.md`, `53-scheduled-handler-isolation-and-liveness-signals.md`, `56-destructive-provider-ownership-proof.md`, `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`.

## Follow-up evidence
- Cutoff/mode mismatch retained in SAM Idea `01M201HT5N8A00RT6STMNJ9GCV`. VM reported normal end_turn at 07:31:11.294, after complete_task returned 07:30:49.414; final stored token 07:31:02.428. Workspace and agent session remain running. No scheduler kill established. Mode remains task in D1 despite user's conversation-mode observation. Subsequent production telemetry proved premature ledger closure, addressed by the expanded patch below.
- Legacy deletion recovery retained in SAM Idea `01M201HSV6EMQTHH35EHXFFRQF`. Inspected PR #2030; strict deletion still requires a fingerprint and no legacy fingerprint recovery writer found. This issue remains unresolved; no ownership-proof bypass or production deletion performed.
- Local review found the real sleep service already releases failed claims before rethrowing. Moved permanent stopped-capture classification into the shared failure writer so its FIRST claim-fenced write becomes terminal; the scheduler's repeated failure handling cannot overwrite renewal. Real service/sweep integration tests added.
- Initial root checks run concurrently exhausted the 4GB workspace (exit 137 / Vitest worker startup timeouts). Re-running via `pnpm exec turbo run lint typecheck test build --concurrency=1`; focused tests separately verify final diff.
- Shared staging occupied by PR #2030 deployment run 34202813781 starting 08:07:28 UTC. Do not overwrite its ongoing verification.

## Proven response-loss cause and expanded implementation
- DO ledger stopped the parent chat at07:31:03.167; D1 summary stopped at07:31:04.531. Sixteen subsequent message batches returned204 dropped_terminal_do_response through07:31:12.011. VM completed normally at07:31:11.294.
- Working activity had erased the completion sleep intent. Preserve that intent while fencing preparing claims; independently protect recently completed or canonically active turns in the DO; make D1 summary repair respect the authoritative open DO session.
- Regression suite exercises completion → working callback → both ledger sweeps → successful final-message persistence, missing intent/state/timestamp, stale expiry, live prompt/background-work leases, explicit wake and stopping-claim safety.
- D1 summary repair adds at most one keyed DO read per otherwise eligible candidate (default25/max200); no VM/provider probe. Protection defers candidates under the existing configured retry interval.
- Remaining mode-selection mismatch and legacy credential-fingerprint recovery remain tracked separately.

- Adjacent long-prompt cutoff prevented: both automatic eligibility and point-of-teardown classifiers now receive the completed timestamp, using the later activity/completion clock before treating a still-prompting terminal task as stale. Confirmed idle still releases immediately. Two policy regressions plus real sweep/teardown integration pass (53 focusedtests); localreviewPASS.
