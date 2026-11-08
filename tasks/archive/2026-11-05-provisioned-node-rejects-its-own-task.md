# Freshly provisioned node rejects the task it was provisioned for (placement spin until timeout)

SAM task: `01M6WSRYE9JX27R5HN13E5RKFM`. Same root cause as idea `01M6MKX6RVAGHX1HDCQB24ZA7T`.
Branch: `sam/stability-cost-fix-freshly-e5rkfm`.

## Problem

On staging (2026-11-05, task `01M6NV9E2X95M1E1823NPEE6YV`, node `01M6NV9SBFV60S86N10B526B0G`), a
conversation task submitted with `resourceRequirements {minVcpu: 2, minMemoryGb: 3.5, exclusiveNode: true}`
provisioned a cx23 (2 vCPU / 4 GB). Once the node was healthy, every workspace placement attempt failed
with `node_capacity_rejected: measured memory headroom would be exceeded after outstanding reservations`
(`hostMemoryReserveMb: 512`). The TaskRunner logged `task_runner_do.workspace_placement_lost`, went back to
node selection, recovered the same node, and repeated about every 6 seconds (21+ cycles in the log sample)
until `Node provisioning timed out after 15 minutes` failed the task. The VM was billed throughout.

## Research findings

### The exact arithmetic (re-verified 2026-11-08 against staging D1)

Node `01M6NV9SBFV60S86N10B526B0G`: observed memory 4096 MB, last heartbeat `memoryPercent: 11.2`
(≈ 459 MB measured), no workspaces. Request 3584 MB.

- Provisioning (`placement-resolver-capacity.ts:202`): `4096 - 512 >= 3584` → cx23 "exactly fits".
- Declared admission (`workspace-resource-capacity.ts:543`): `0 + 3584 <= 4096 - 512` → admits.
- Measured admission (`workspace-resource-capacity.ts:562-579`, SQL twin in
  `workspace-admission-sql.ts` `workspaceAdmissionEligibilitySql`):
  `459 + 0 - 0 + 3584 <= 4096 - 512` → **rejects**. At exact fit it rejects whenever measured use > 0,
  i.e. always.

### Root cause: the measured check counts host overhead twice (rule 74 proxy mismatch)

- **Condition** the measured check exists for (added in #2470, OOM admission): workloads on the node use
  more memory than their declared reservations, so declared accounting under-states real pressure.
- **Signal** it uses: whole-host used memory (`MemTotal - MemAvailable`, vm-agent
  `sysinfo.ParseMemInfo`) — which includes the host's own processes (OS, dockerd, vm-agent).
- **Divergence**: host processes are already paid for by the static host reserve (the same reserve
  cloud-init subtracts to cap `sam-workload.slice` `MemoryMax`). The formula
  `measured + reservations + request <= total - reserve` charges host overhead once as part of
  `measured` and again as `reserve`. On an empty node the signal measures only host overhead, never a
  workload overrun, so it fires with no co-tenant at all.

### The static 512 MB reserve is below real host overhead

Production/staging nodes with no active workspace at last heartbeat (created since 2026-10-01):

| Memory | Count (prod) | min / avg / max measured host use (MB) | > 512 MB |
| ------ | ------------ | -------------------------------------- | -------- |
| 4 GB   | 30           | 500 / 576 / 770                        | 28       |
| 8 GB   | 122          | 565 / 670 / 3645 (outlier)             | 122      |
| 16 GB  | 92           | 655 / 745 / 1278                       | 92       |
| 32 GB  | 30           | 852 / 1167 / 6095 (outlier)            | 30       |

Staging: 4 GB 459 / 584 / 774; 8 GB 598 / 620 / 729. The freshly provisioned incident node read 459 MB.
So even after removing the double count, a 512 MB reserve cannot make "fits the catalog" imply
"admissible" — and it is too small to protect the agent from the workload slice either.

### Production heartbeats carry no `workspaceMemory`

`nodes.last_metrics` on every running production node lacks the `workspaceMemory` array, so the
observed-usage credit never applies and occupied nodes charge every running workspace twice (its
measured use and its full reservation). Not the cause of this incident (the incident node was empty).
Deferred: `tasks/backlog/2026-11-08-heartbeat-workspace-memory-missing.md`.

### Nominal vs MemTotal

Declared budgets use the provider's nominal memory (4096); cloud-init caps the workload slice at
`MemTotal - reserve`, and MemTotal is ~5–7% below nominal. Pre-existing and separate. Deferred with
the item above (same backlog file) so the evidence stays together.

### The replan loop

`workspace-steps.ts` `createAndProvisionWorkspace`: on `reserveWorkspacePlacement === false` it clears
`stepResults.nodeId`/`autoProvisioned`, releases the lease, and advances to `node_selection`.
`node_selection` rejects the node (advisory evaluator agrees with SQL), advances to
`node_provisioning`, where `adoptProvisionedNodeAfterCrash` re-adopts `tasks.auto_provisioned_node_id`,
then `node_agent_ready`, then `workspace_creation` again. Nothing counts the cycles; only the
15-minute `provisioningStartedAt` timeout ends it. On that timeout, failure cleanup warm-hands-off the
node (`state-machine.ts` `cleanupOnFailure` → `NodeLifecycle.markIdle`).

## Design decision

One memory accounting policy, used by provisioning and both admission paths:

> host overhead = max(configured host reserve, measured memory not attributed to observed workspaces);
> admit iff host overhead + active reservations + request <= node memory.

- Provisioning assumes host overhead = reserve (it cannot measure a node that does not exist yet).
- Admission uses the measured value only when it exceeds the reserve. This removes the double count,
  keeps the #2470 protection (co-tenant overrun beyond reservation and leaked/orphan usage still show
  up as unattributed use above the reserve), and leaves declared reservations as the authority
  (rule 74 requirement 3).
- The two agree on a fresh node whenever its real host overhead <= reserve. So the default reserve rises
  from 512 to 1024 MB, above the observed fresh/idle overhead for 4–16 GB machines. Same knob
  (`TASK_RUN_NODE_HOST_MEMORY_RESERVE_MB` / `VM_AGENT_MEMORY_RESERVE_MB` / project scaling), so cloud-init's
  workload-slice reserve moves with it. No GitHub Environment override of either var exists
  (checked 2026-11-08, staging and production).
- Alternative rejected: "admission honours the provisioning reservation" (skip the measured check on a
  node provisioned for this task). It would admit 3.5 GB onto a cx23 whose workload slice is capped at
  ~3.2 GB, and would ignore leaked usage on an empty node.
- Alternative rejected: a separate provisioning margin while keeping admission's double count. Two
  policies for one resource is what rule 69 forbids.
- Compressible vs non-compressible: CPU keeps its own policy (declared budget authority, saturation-only
  live ceiling). This change touches memory only.

Consequence: requests of 3.0–3.5 GB now provision an 8 GB machine instead of a 4 GB machine that could
never admit them. Platform default (4 GB) and legacy small/medium/large reservations land on the same
offerings as before. Rule 09's dispatch ceiling becomes 3 GB (`minMemoryGb <= 3`).

Bounded replan: count consecutive placement refusals per task run (reset on a successful reservation,
rule 61). After `operations.workspacePlacementMaxRejections` (default 3) the task fails fast with the
refusal reasons from the shared evaluator, persisted into `tasks.placement_explanation_json` notes, and
keeps `stepResults.nodeId`/`autoProvisioned` so failure cleanup warm-hands-off a node it provisioned.

Throughput (rule 81): one refusal cycle (workspace_creation → node_selection → node_provisioning adopt →
node_agent_ready → workspace_creation) took ~6 s on staging. Default cap 3 → worst case ≈ 18 s before
the task fails and the node is handed off; max configurable cap 20 → ≈ 2 min. Previously unbounded
until the 15-minute provisioning timeout (~150 cycles).

## Implementation checklist

- [x] Split `workspace-steps.ts` (659 lines, rule 18): move the dispatch step into its own module (separate commit)
- [x] `evaluateWorkspaceReservationCapacity`: measured check charges `max(reserve, unattributed measured)`; comment names condition, signal and divergence; reason string names the condition
- [x] `workspaceAdmissionEligibilitySql`: same formula in the atomic SQL
- [x] `DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB` 512 → 1024 with a comment citing the measured overhead
- [x] Admin setting `operations.workspacePlacementMaxRejections` + `DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS`
- [x] TaskRunner state counter (consecutive, reset on success), fail fast at cap, diagnose reasons via shared evaluator, persist diagnostics note, keep node for warm handoff
- [x] Tests: divergence through real producer (catalog selection → real TaskRunner admission on D1), red pre-fix
- [x] Tests: convergence control (unattributed use above reserve still refuses; co-tenant overrun still refuses)
- [x] Tests: defaults through the real resolver (no overrides)
- [x] Tests: cap test driving the real alarm loop past the cap; node handed off warm; counter reset on success
- [x] Update existing tests that assumed 512 / the double-count formula
- [x] Docs: configuration.md, compute-pools.md, admin-settings.md, architecture overview if it states the formula, www placement explorer constant
- [x] `.claude/rules/09` ceiling 3.5 → 3 GB (and policy `d8f2a083` text after merge)
- [x] Backlog task for heartbeat `workspaceMemory` absence + nominal vs MemTotal
- [x] Staging: dispatch a task at exactly the documented cap (3 GB / 2 vCPU), show it lands on the node it provisioned, clean up

## Implementation notes

- Splits: `workspace-steps.ts` → `workspace-dispatch-step.ts` (089ca8019); `workspace-resource-capacity.ts` →
  `workspace-admission-policy.ts` + `workspace-reservation-usage.ts` (83e4d6610). Pure code motion.
- Fix: 80724e302. Tests and docs: 51ad96e54, afadf320e.
- Discrimination (verified by surgical revert, then restored):
  - matrix test red with the reserve reverted alone (7680 MB on cx33) and with the formula reverted alone (3072 MB on cx23);
  - SQL-twin test red with only the SQL reverted (3 of 5);
  - workers at-cap test red with the formula reverted; workers cap test red with the cap disabled.
- Legacy `small` (1152 MiB) now fits two per cx23 by declared accounting instead of three. In practice three never
  fit, because the old double count with no `workspaceMemory` credits refused them.
- Also: the cloud-init fallback reserve is 1024 (pinned by `host-memory-reserve-default-sync.test.ts`); the specified-node
  first-refusal path is tested; the dispatch module is allowlisted in the branch-guard scan because the creation step runs the guard.

## Acceptance Criteria

- [x] A node auto-provisioned for a task with `minMemoryGb: X` can admit that task (one shared accounting policy)
- [x] The placement-lost loop is bounded with a configurable cap and `DEFAULT_*`; fails fast with a specific reason recorded in placement diagnostics; the provisioned node is warm-handed-off
- [x] Throughput/worst-case of the bound stated (above)
- [x] Divergence test red pre-fix, convergence control, real-resolver defaults, cap test past the cap
- [x] Rule 09 guidance updated in the same PR
- [x] Staging: task at the documented cap lands and runs on the node it provisioned; node cleaned up

## Staging verification (2026-11-08, deploy run 42477465235, commit 1d4e51b05)

- The live Worker version was annotated `commit:1d4e51b05…` at 100%. Before the test, staging had no VM nodes and the platform Hetzner credential was enabled.
- Task `01M6XGQJVCV4PEDN3NS5M7FAHQ` (project hono): 2 vCPU / 3 GB, exclusive node.
  - Provisioning chose a **cx23** (node `01M6XGQXB4S3KRFBWCTBG2D2GZ`, 4096 MB). Its first heartbeat read `memoryPercent` 20 (≈ 819 MB) while booting, then settled at 14–15%.
  - Admission placed workspace `01M6XGX9MKRCHSQS80RX29KVYW` on that same node on the first attempt (queued → delegated at 12:07:48), with no refusal notes. The old formula would have refused it every time (819 + 512 + 3072 > 4096).
  - The agent (opencode) started, but the model provider refused the prompt with `provider.budget-limit` ("Workspace usage limit reached"). This is the smoke user's OpenCode Go quota and unrelated to placement.
- Task `01M6XH7R0VWH3BGJ0696DZREDX`, same cap, "Claude Code VM Chat" profile.
  - Placed on the same cx23 at exact fit (memory 14.6%), workspace `01M6XH814HQ09TKE061P2ANJWS`.
  - The agent ran and replied "OK", and the task **completed**. The project chat screenshot shows the reply and summary with no console errors.
- Regression: dashboard, projects and settings load with no console errors. Deploy smoke tests passed.
- Cleanup: `DELETE /api/nodes/01M6XGQXB4S3KRFBWCTBG2D2GZ` → 200. The node row is gone, and staging has 0 VM nodes.
- Deploys from 08:47 to 11:47Z failed on a GitHub incident (github.com release downloads 503/504, "timeouts for some unauthenticated users"). Added curl retries plus an authenticated API-asset fallback for the Codex runtime archive (d79da0282, 1d4e51b05), tested with fake curl and with a real run during the outage. The opencode installer inside the container image still downloads unauthenticated.
- CI follow-up: `deploy-staging-permissions.test.ts` forbids any token consumer in `deploy-reusable.yml` (the PR-write guard). The `GITHUB_TOKEN` env was reverted, so in CI the API fallback runs unauthenticated (60 requests/hour per IP; verified 200 for the asset). A token remains optional for local and self-host callers, and a test covers the no-token path.
