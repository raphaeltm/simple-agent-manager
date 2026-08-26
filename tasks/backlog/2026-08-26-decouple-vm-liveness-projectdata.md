# Decouple VM liveness from ProjectData and bound maintenance

## Problem

On 2026-08-26, production ProjectData Durable Object storage
measurement/maintenance on a hot project object stalled ACP heartbeat writes.
Stuck-task reconciliation and ProjectData alarm heartbeat handling then treated
stale or missing ProjectData ACP heartbeat data as conclusive runtime death and
terminalized healthy VM sessions.

ProjectData must remain durable history and storage, not the sole authoritative
runtime failure detector for VM work. Failure to observe ProjectData ACP
heartbeat data must be classified as suspect or unknown unless there is explicit
terminal evidence, terminal owning node/workspace state, or repeated exact
absence from authoritative runtime inventory with fencing and a just-in-time
reread before destructive cleanup.

## Research findings

- SAM idea `01M0Y6N63R23N7HDH4V0X1T49G` documents the production incident and
  local reproduction evidence:
  - Four healthy Codex VM tasks on node `01M0XRQR78C0CSHAHQG3QRRMZW` were
    falsely failed as `task_acp_session_not_live`.
  - The node ACP heartbeats updated successfully at 04:10:41 and 04:11:41 UTC.
    After Worker deploy `9202e62f-d35f-407a-bb53-651f178f5efc`, direct
    `node-acp-heartbeat` writes were canceled around 10s and backup sweeps hit
    the 15s timeout.
  - The owning node and workspaces were healthy; TaskRunner probes worked and
    agents had fresh output.
  - The dogfooding ProjectData DO was about 8.548 GB. Storage measurement and
    cleanup alarms performed category scans every minute, with 10-25s and
    sometimes 50s alarm work.
  - Repeated deploy secret resets created Worker versions and reset DO alarms,
    amplifying the hot path.
- `apps/api/src/services/task-runtime-liveness.ts` currently treats a missing or
  stale ProjectData ACP session as conclusive non-liveness after node/workspace
  checks pass. This is the unsafe VM kill path.
- `apps/api/src/scheduled/stuck-tasks.ts` already preserves tasks when
  ProjectData probes timeout or error, but it consumes the classifier's final
  `task_acp_session_not_live` verdict as terminal and then performs a separate
  destructive D1 update/cleanup path instead of the canonical terminalizer.
- `apps/api/src/durable-objects/project-data/task-runtime-liveness.ts` reuses
  the same classifier for local ProjectData alarm decisions, so the unsafe
  terminal verdict exists in both scheduled reconciliation and DO alarm paths.
- `apps/api/src/durable-objects/project-data/runtime-heartbeat-policy.ts`
  currently returns `defer:false` for non-`cf-container` runtimes, which allows
  VM ProjectData ACP heartbeat age alone to interrupt live sessions.
- `apps/api/src/durable-objects/project-data/index.ts` runs storage safety before
  runtime heartbeat and reconciliation work inside the alarm. In the incident,
  this allowed optional storage measurement/maintenance to delay control-plane
  bookkeeping.
- `apps/api/src/durable-objects/project-data/storage-telemetry.ts` and
  `storage-category-telemetry.ts` compute category breakdowns using broad table
  scans. This is acceptable for explicit/admin measurement, but not for a hot
  alarm path.
- `apps/api/src/durable-objects/project-data/tool-payload-cleanup.ts` already
  uses bounded row and byte budgets for tool-payload cleanup candidates. The
  remaining risk is that alarm-triggered telemetry still performs unbounded
  category measurements before or during cleanup telemetry.
- `apps/api/src/routes/node-lifecycle.ts` receives authoritative VM node
  heartbeats and performs a best-effort ProjectData ACP heartbeat fanout. This
  route is the natural place to accept a bounded VM runtime session inventory and
  maintain D1-backed runtime leases independent of ProjectData.
- `packages/vm-agent/internal/agentsessions/manager.go` has an in-memory
  session registry with session ID, workspace ID, status, ACP session ID, and
  timestamps, but node heartbeat payloads do not currently include runtime
  session inventory or fencing fields.
- `apps/api/src/services/task-terminal-transition.ts` already provides a
  canonical idempotent terminal transition path used by some ProjectData
  reconciliation flows. Stuck-task terminalization should move toward this path
  so independent schedulers do not perform duplicate destructive state changes.
- `scripts/deploy/configure-secrets.sh` currently calls `wrangler secret put`
  per secret and deletes stale secrets one at a time. Cloudflare's official
  Workers documentation supports `wrangler secret bulk` and a bulk secrets API
  that can set multiple secrets and delete stale secrets with `null` values while
  preserving safe handling of secret values.
- Relevant durable process rules:
  - `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
  - `.claude/rules/47-control-loop-io-budget.md`
  - `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
  - `.claude/rules/57-write-only-cross-boundary-state.md`
  - `.claude/rules/44-dual-write-migration-enumerate-writers.md`
  - `.claude/rules/54-vm-agent-rollout-compatibility.md`
  - `.claude/rules/34-vm-agent-callback-auth.md`

## Implementation checklist

- [ ] Add immediate liveness guardrails so stale, missing, timed-out, or
  unobservable ProjectData ACP heartbeat data is suspect/unknown for VM runtime
  tasks instead of conclusive runtime death.
- [ ] Preserve conclusive terminalization for explicit terminal evidence and
  terminal owning workspace/node state.
- [ ] Update stuck-task tests so a healthy VM node with missing ProjectData ACP
  rows is preserved, and a dead runtime still converges exactly once with
  conclusive evidence.
- [ ] Update ProjectData runtime heartbeat timeout policy so non-container VM
  sessions are not interrupted solely because ProjectData ACP heartbeat data is
  stale.
- [ ] Move stuck-task destructive cleanup toward the canonical idempotent
  terminal transition service, including just-in-time status checks/CAS before
  cleanup.
- [ ] Add D1-backed runtime session leases and/or a scoped shadow lease path from
  bounded VM node heartbeat inventory when it fits the PR size.
- [ ] If runtime inventory is added, keep VM-agent rollout additive and
  version-aware; old agents must remain compatible and incompatible busy VMs must
  not be killed due to missing inventory.
- [ ] Bound ProjectData alarm maintenance by keeping hot-path storage checks O(1)
  with `sql.databaseSize`, moving category breakdown scans out of ordinary alarm
  execution, and ensuring cleanup batches are indexed/bounded with cursor/yield
  behavior.
- [ ] Reorder or isolate ProjectData alarm work so lifecycle/control bookkeeping
  is not delayed by optional storage maintenance.
- [ ] Add telemetry for storage alarm duration, rows, bytes, and budget decisions
  where missing.
- [ ] Replace repeated per-secret `wrangler secret put` / delete loops in
  `scripts/deploy/configure-secrets.sh` with a bulk/bounded secret workflow that
  never logs secret values.
- [ ] Update public/internal documentation and environment references for any new
  liveness, storage, or deploy-secret settings.
- [ ] Run targeted unit and Miniflare/workerd tests proving:
  - healthy VM/runtime survives blocked, stale, or missing ProjectData ACP data;
  - conclusive terminal evidence still fails dead work;
  - ProjectData alarm heartbeat timeout does not kill VM sessions on stale
    ProjectData heartbeat alone;
  - ProjectData storage alarm does not run unbounded category scans;
  - deploy-secret bulk workflow redacts values and bounds Worker-version churn.
- [ ] Run broader API, Worker, deploy-script, and VM-agent checks as applicable.
- [ ] Complete specialist review, staging verification, PR CI, merge, and
  production deploy monitoring.

## Acceptance criteria

- A healthy VM task with running workspace/node evidence is not failed when the
  ProjectData ACP heartbeat row is stale, missing, timed out, or unobservable.
- ProjectData DO alarms do not interrupt VM ACP sessions solely from stale
  ProjectData heartbeat age.
- Explicit terminal evidence and terminal owning workspace/node state still
  converge to one terminal task transition through an idempotent terminalizer.
- Any runtime inventory absence-based terminal decision, if implemented, requires
  repeated exact absence from authoritative inventory with incarnation/sequence
  fencing and a just-in-time reread/CAS before destructive cleanup.
- ProjectData storage safety alarm work is bounded: O(1) size checks in the hot
  path, no ordinary alarm category table scans, bounded cleanup batches, cursor
  progress, and telemetry for work performed.
- Deploy secret configuration updates use a bulk/bounded workflow where
  applicable and do not log secret values.
- Existing production safety policies remain intact: security-sensitive
  boundaries fail closed, no new destructive agent-facing deployment control is
  exposed without user-visible controls, and missing user cloud credentials are
  not treated as a staging/provisioning blocker when platform credentials exist.
- Focused unit tests, Worker/Miniflare tests, relevant broader checks, staging
  verification, PR CI, merge, and production deploy monitoring all complete.

## References

- SAM idea `01M0Y6N63R23N7HDH4V0X1T49G`
- Bootstrap task-file PR `#1926` was required because direct push to `main` was
  rejected by branch protection. No implementation changes belong in that PR.
- `apps/api/src/services/task-runtime-liveness.ts`
- `apps/api/src/services/stuck-tasks.ts`
- `apps/api/src/scheduled/stuck-tasks.ts`
- `apps/api/src/durable-objects/project-data.ts`
- `apps/api/src/durable-objects/project-data/index.ts`
- `apps/api/src/durable-objects/project-data/runtime-heartbeat-policy.ts`
- `apps/api/src/durable-objects/project-data/storage-safety.ts`
- `apps/api/src/durable-objects/project-data/storage-telemetry.ts`
- `apps/api/src/durable-objects/project-data/storage-category-telemetry.ts`
- `apps/api/tests/unit/services/task-runtime-liveness.test.ts`
- `apps/api/tests/unit/acp-session-heartbeat-timeout.test.ts`
- `apps/api/tests/unit/stuck-tasks.test.ts`
- `apps/api/tests/workers/project-data-storage-safety.test.ts`
- `apps/api/tests/workers/scheduled-stuck-tasks.test.ts`
- `scripts/deploy/configure-secrets.sh`
- Cloudflare Workers secrets documentation:
  <https://developers.cloudflare.com/workers/configuration/secrets/>
- Cloudflare bulk secrets API changelog:
  <https://developers.cloudflare.com/changelog/post/2026-06-03-bulk-secrets-api/>
