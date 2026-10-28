# Safe node disk cleanup

Rebuild of interrupted task01M5YF5N469Z2SSS6FTDQ9C9YJ; current owner01M5ZB6QDY4Q5Q08M1G4PE70EW. Human authorized rebuilding prior lost code from transcript Oct28. Research idea01M5Y9YDCHT02HYPRGXKV2Y2DP; original chatf997ca0f-66b2-4472-b46f-35cc54d813a7/research2dae5dce-f09a-4a9c-a155-ba1561113b3c.

## Problem and research

Node workspace deletion drops runtime metadata despite swallowed container/volume errors and leaves host clones. Existing control-plane deletion claims/proof/retries must remain authoritative. Failed provisioning, failed sleep/wake and evicted source data can be the only recovery copy. Node status/age/pressure alone cannot authorize destructive cleanup. Existing lifecycle lock serializes runtime transitions; extend exact identity through it. Deployment imageGC already protects rollback images and is excluded.

## Implementation and acceptance

- [ ] Durable local deletion intent records exact owned artifacts before removal; propagate partial failures; retain identity/state until absence verified; delete validated owned host clones.
- [ ] Same operation on bounded periodic/restart reconciliation; unknown/legacy artifacts report-only; configurable budgets/backoff and fail closed.
- [ ] Control plane transmits node incarnation/workspace generation/owner fences; central preservation authority for automatic lifecycle cleanup; explicit deletion remains distinct.
- [ ] Preserve failed snapshot and unpreserved provisioning/wake/eviction sources; retire only after verified preservation/handoff.
- [ ] Narrow owned image-transfer scratch cleanup with active protection and dry-run default, configurable limits; exclude user/nested Docker volumes/caches and deployment/rollback images.
- [ ] Meaningful tests: partial deletion/retry/restart/duplicates; wake/rebuild/snapshot races; stale identities; preservation failures and eviction handoff; standalone; symlink/mount escapes; nested/user volumes and rollback preservation.
- [ ] Docs/env references match code; no new admin routes unless matching phone UI supplied.
- [ ] Local suite and independent Go/Cloudflare/security/constitution/completion reviews pass.
- [ ] Bounded coordinated staging lifecycle sweep with dirty/untracked data, failure injection/restart and repeated no-leak cycles; real VM heartbeat/access; promptly clean own staging resources.
- [ ] DraftPR, greenCI, best-effort CodeRabbit request+wait; normal authorized release/basic production smoke.

No cutoff changes (#2450 shipped). No manual production deletion, blanket prune, forced retirement, automatic platform Git publication, or age/status/pressure-only workspace deletion.
