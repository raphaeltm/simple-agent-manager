# Safe node disk cleanup

Rebuild of interrupted task01M5YF5N469Z2SSS6FTDQ9C9YJ; current owner01M5ZB6QDY4Q5Q08M1G4PE70EW. Human authorized rebuilding prior lost code from transcript Oct28. Research idea01M5Y9YDCHT02HYPRGXKV2Y2DP; original chatf997ca0f-66b2-4472-b46f-35cc54d813a7/research2dae5dce-f09a-4a9c-a155-ba1561113b3c.

## Problem and research

Node workspace deletion drops runtime metadata despite swallowed container/volume errors and leaves host clones. Existing control-plane deletion claims/proof/retries must remain authoritative. Failed provisioning, failed sleep/wake and evicted source data can be the only recovery copy. Node status/age/pressure alone cannot authorize destructive cleanup. Existing lifecycle lock serializes runtime transitions; extend exact identity through it. Deployment imageGC already protects rollback images and is excluded.

## Implementation and acceptance

- [x] Durable local deletion intent records exact owned artifacts before removal; propagate partial failures; retain identity/state until absence verified; delete validated owned host clones.
- [x] Same operation on bounded periodic/restart reconciliation; unknown/legacy artifacts report-only; configurable budgets/backoff and fail closed.
- [x] Control plane transmits node incarnation/workspace generation/owner fences; central preservation authority for automatic lifecycle cleanup; explicit deletion remains distinct.
- [x] Preserve failed snapshot and unpreserved provisioning/wake/eviction sources; retire only after verified preservation/handoff.
- [x] Narrow owned image-transfer scratch cleanup with active protection and dry-run default, configurable limits; exclude user/nested Docker volumes/caches and deployment/rollback images.
- [x] Meaningful tests: partial deletion/retry/restart/duplicates; wake/rebuild/snapshot races; stale identities; preservation failures and eviction handoff; standalone; symlink/mount escapes; nested/user volumes and rollback preservation.
- [x] Docs/env references match code; no new admin routes unless matching phone UI supplied.
- [x] Local suite and independent Go/Cloudflare/security/constitution/completion reviews pass.
- [ ] Bounded coordinated staging lifecycle sweep with dirty/untracked data, failure injection/restart and repeated no-leak cycles; real VM heartbeat/access; promptly clean own staging resources.
- [ ] DraftPR, greenCI, best-effort CodeRabbit request+wait; normal authorized release/basic production smoke.

No cutoff changes (#2450 shipped). No manual production deletion, blanket prune, forced retirement, automatic platform Git publication, or age/status/pressure-only workspace deletion.

## Validation evidence (Oct 28, before staging)

No previous agent implementation recovered; rebuilt from original transcript per human direction. Original branch checkpoints through 4aa91533b pushed. Physical deletion capability route intentionally differs from old DELETE so old agents fail closed.

- Go server/persistence/config/bootstrap suites passed (1,600 cases including subtests); focused deletion race suites passed; `go vet ./...` passed. Transfer scratch/deploy/publish race suites passed, including actual subprocess termination/retry. Actual bind-mount test skipped locally because mount denied (EPERM); privileged staging proof remains required.
- Root build passed 9 tasks, lint passed 13 tasks (three existing web warnings), typecheck passed 19 tasks (Astro baseline diagnostic accepted by existing validator). Migration ordering, runtime tunable ratchet, file size checks and agent context measurement passed.
- Worker lifecycle suite passed 76/76, including same-operation transient CF retirement retry and successor incarnation protection. Final full API rerun: 978 files (977 passed, one skipped), 14,055 tests passed, two skipped. Archive/retirement fixtures now require physical proof and preserve unconfirmed data. Prior root full suite aborted on web comment-reader timing failure; isolated rerun passed 16/16.
- Independent Go/security review passed after fixes; Cloudflare/security review found caller ownership and successor snapshot races, fixed and reverified with 71 tests passed. Scratch review passed; constitution/env review passed. Completion review remains open until remaining validation and release gates.
- Staging candidate a893cd2e7e1cf0e52b722ee7b66ca1b5a090f621 is deploying in run40653426846; no PR/CI/CodeRabbit or production release yet. Staging preflight authenticated successfully; no active staging deployment observed. No production resources mutated.

Final independent review: API/Cloudflare/security PASS after source/capture/handoff snapshot CAS, caller fences, strict Stop behavior and same-operation CF retirement retry. Scratch/Go/process-test reviews PASS; whole VM Agent `go test ./...` PASS. Completion release evidence remains pending.
