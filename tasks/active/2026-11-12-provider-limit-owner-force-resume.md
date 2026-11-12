# Owner force-resume of saved provider-limited sessions

## Problem

Raphaël reports externally resetting his selected Claude account and cannot find the previous force control to deliver his latest message in the existing sleeping session. SAM still records the earlier rejection. The callback-origin waiting hold has neither admission-only Start anyway nor blocked-only Resume task. Canonical idea: 01M73WJGGD2TZP6XDFHJJWHD33, note 01M77SJS07XVH3MD6NVWCQNNNB.

## Research

- `provider-limit-recovery.ts`: existing admission override is credential scoped; keep admission/blocked semantics and add saved waiting eligibility separately.
- `session-recovery.ts`: existing waking claims must remain intact; nudge their stable TaskRunner. Unclaimed snapshots use normal recovery, preserving bounded attempts and snapshot degradation.
- `provider-limit-admission.ts`: released override bypasses live rejected window; must bind profile/current credential and deadline, preserve changed-account review.
- `project-event-schedules-delivery.ts`: scheduled callback continuation validates scheduleKey before submit; changing the key invalidates obsolete pending notices. Reconcile must still inspect already-issued receipts.
- Existing restored-session prompt machinery retains original accepted inbox messages. Do not repost/fork/replay.
- Sol owns shared catalog/placement and committed-active/readiness fixes. Coordinate imports and staging, do not duplicate. No migration expected; 0237 reserved elsewhere.

## Implementation checklist

- [ ] Add one owner operation for waiting callback parked sessions using existing override/recovery mechanisms.
- [ ] Fence task/wait, snapshot/claim, credential/profile and deadline; retain claim across ambiguous runner response.
- [ ] Keep original inbox/delivery identities and reconcile already-issued receipts; invalidate obsolete scheduled continuation.
- [ ] Add thin HTTP adapter and owner-only session notice action with pending/error state.
- [ ] Exercise public action in Workers through live rejected windows, claimed/unclaimed recovery and original delivery once.
- [ ] Cover double click, non-owner/access revocation, expired/degraded snapshot, cancellation, mutation/races and fresh rejection.
- [ ] Run API/UI quality checks and desktop/mobile screenshot audit.
- [ ] Update API/user docs; specialist reviews and task-completion review.
- [ ] Coordinate bounded real staging validation and cleanup.
- [ ] Draft PR, CI, CodeRabbit, full-head evidence to coordinator.

## Acceptance criteria

Owner can request Resume anyway on an eligible callback waiting saved session before reset. Existing task/snapshot/profile/account and original accepted delivery remain authoritative. Claimed recovery advances without claim replacement. Unclaimed recovery uses normal restoration. A changed account/profile cannot inherit consent; terminal/expired/cancelled work cannot advance. An actual rejection re-parks and clears override; repeated clicks do not duplicate work. UI is usable on mobile/desktop. Tests, review and real staging evidence precede release.

## Release gate

Keep PR draft until coordinator 01M77NV1B621TKTV79272F7YX3 independently approves full 40-character head. Every new commit invalidates approval. No production DB bypass, reset or replay. Automatic overage parsing remains separate in canonical idea.
