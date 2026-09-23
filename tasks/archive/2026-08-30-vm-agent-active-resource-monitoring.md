# VM Agent active resource monitoring

## Problem

The VM agent currently persists periodic host resource snapshots and can assemble on-demand diagnostic packages, but it does not actively surface memory pressure, container OOM kills, or per-container resource trends while work is running. This makes node overload and container-level failures harder to correlate with task lifecycle events.

## Constraints

- Base branch: `sam/layered-resource-management`.
- Output branch: `sam/add-active-resource-monitoring-hcpb01`.
- PR target must be `sam/layered-resource-management`, not `main`.
- Monitoring only: do not add eviction, scheduling, or workspace termination decisions.
- Docker interactions must remain CLI-based with `exec.Command("docker", ...)`; do not add the Docker SDK.
- Reuse or extend the existing Docker stats parsing in `internal/sysinfo`; do not create a duplicate implementation.
- Any background-updated state exposed through getters must be synchronized and covered by a race regression test.
- PSI must degrade gracefully when `/proc/pressure/memory` is unavailable.
- Docker event subprocesses must shut down cleanly with the server.
- New intervals and thresholds must be configurable through `DEFAULT_...` environment variables.

## Research findings

- `packages/vm-agent/internal/resourcemon/monitor.go` owns the existing historical SQLite snapshot monitor. It collects host load/memory/disk once per interval and should remain separate from active pressure event monitoring.
- `packages/vm-agent/internal/sysinfo/sysinfo.go` already shells out to `docker stats --no-stream`, but its parser is package-private and currently returns string memory usage only. This should be extended/exported for `resourcemon` instead of duplicating parsing.
- `packages/vm-agent/internal/config/config.go` and `config_load.go` use Go `Default...` constants plus env overrides. New `DEFAULT_...` env names can follow the same loader and validation pattern.
- `packages/vm-agent/internal/server/server.go` starts the existing `resourcemon.Monitor` in `New()` and owns shutdown in `Stop()`. Active monitoring should be wired into this lifecycle and stopped explicitly.
- No existing code writes a `sam.workspace.id` Docker label. OOM correlation should read the label when present and leave the workspace ID empty if a Docker event lacks it.
- `.claude/rules/46-vm-agent-diagnostic-getter-sync.md` requires synchronization for any background-mutated state read by HTTP-reachable getters and a `-race` regression test.

## Implementation checklist

- [x] Extend `internal/sysinfo` Docker stats parsing with reusable typed fields for memory usage bytes, memory limit bytes, memory percent, CPU percent, and PIDs.
- [x] Add PSI memory pressure parsing and threshold classification with graceful unavailable behavior.
- [x] Add Docker event parsing and a CLI-backed OOM/die-137 event subscriber with clean shutdown.
- [x] Add per-container metrics polling on a configurable interval using the shared sysinfo Docker stats parser.
- [x] Add a unified `ResourceGuard` with synchronized pressure snapshots and non-blocking pressure events.
- [x] Wire `ResourceGuard` into the VM agent server lifecycle and log warning/critical events without eviction.
- [x] Add config defaults, env overrides, validation, and docs/examples for new intervals and thresholds.
- [x] Add parser, degradation, default-constant, and concurrent getter race tests.
- [x] Run focused Go tests, race tests, and applicable repository quality gates.
- [x] Review with required specialist skills.
- [x] Create a PR targeting `sam/layered-resource-management`.

## Acceptance criteria

- PSI parser handles realistic Linux `/proc/pressure/memory` content and classifies `none`, `warning`, and `critical`.
- Missing PSI files disable PSI monitoring without failing the resource guard.
- Docker OOM and die-137 events parse correctly and expose workspace/container identifiers.
- Container stats parsing returns per-container CPU, memory bytes/limit, memory percent, and PIDs.
- ResourceGuard getters are safe under concurrent polling and reads under `go test -race`.
- All new operational thresholds and intervals use configurable defaults, not hardcoded implementation values.
- Server starts and stops active monitoring cleanly, including the Docker events subprocess.

## Validation notes

- `go test ./internal/resourcemon ./internal/sysinfo ./internal/config` — passed.
- `go test -race ./internal/resourcemon -count=1` — passed.
- `go test ./...` from `packages/vm-agent` — passed.
- `go vet ./...` from `packages/vm-agent` — passed.
- `git diff --check` — passed.
- `pnpm check:fast` — passed; existing unrelated lint warnings remained warnings only.
- Staging deploy run `33306230453` — passed: Cloudflare deploy, VM-agent binary upload, health check, and built-in Playwright smoke tests passed.
- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1971 targeting `sam/layered-resource-management`.
- Real staging VM verification — passed:
  - Temporary Artifacts project: `01M193Z44W14CM49NWR72GWQPP`.
  - Temporary workspace: `01M193Z9R320T8EMYBAWS7YKHN`.
  - Temporary node: `01M193Z99VVW2J8R6M5BV7XR6K`.
  - Node heartbeat observed healthy/fresh at `2026-08-30T10:42:05.217Z` with ~30s lag at verification time.
  - Workspace reached `running` at `2026-08-30T10:42:34.377Z`.
  - Terminal WebSocket echo marker `sam-resource-monitor-smoke-20260830103808` succeeded at `2026-08-30T10:42:37.600Z`.
  - Temporary workspace, node, and project were deleted by `2026-08-30T10:42:49.251Z`.

## Review notes

- `$task-completion-validator`: PASS — research findings, checked checklist items, and acceptance criteria are represented in the worktree diff and validation evidence; no UI/backend or multi-resource selection path is in scope.
- `$go-specialist`: PASS — Docker interactions remain CLI-based, subprocess and ticker lifecycles are context-owned and explicitly closed, synchronized guard getters avoid background-reader data races, and full vm-agent Go tests pass.
- `$test-engineer`: PASS — parser, graceful degradation, command-shape, subprocess cleanup, config default/override, shared Docker stats parser, and race coverage are present.
- `$constitution-validator`: PASS — new thresholds and intervals are centralized as defaults with env overrides and validation; domain constants such as `sam.workspace.id` and Docker exit code `137` are protocol identifiers.
- `$env-validator`: PASS — new process-level VM-agent env vars are documented in `packages/vm-agent/.env.example` and `.claude/skills/env-reference/SKILL.md`; no API Worker or GitHub Actions secret mapping is required.
- `$doc-sync-validator`: PASS — documentation touched matches code-level env names/defaults and no public API, schema, or UI documentation is affected.

## PR #1980 integration completion (2026-09-13)

The original component PR evidence above is historical. The combined change must
pass the gates below against current `main` before merge.

### Reconciliation and review findings

- Current main already implements and verifies the cgroup workload hierarchy,
  infrastructure CPU priority, and effective shared host-memory reserve. Preserve
  those paths; the original Docker-service-only limit and 768 MB default are
  superseded.
- Resource telemetry must reuse `internal/sysinfo/docker_metrics.go` with bounded
  subprocess output and cancellation, preserving heartbeat label filtering.
- Eviction must prove the actual container label and current runtime identity,
  including exited OOM victims and delayed events from an older container run.
- Failed container stops must remain retryable. Sustained critical PSI must be
  reconsidered with fresh data and cooldown; Docker monitoring must reconnect.
- API eviction must atomically close usage/session records, finalize ProjectData
  state, and preserve the stopped overlay. Explicit restart must reserve capacity
  and reject delayed callbacks from previous restart generations. Automatic
  rescheduling remains outside this PR.
- A nullable D1 generation/finalization marker and local SQLite generation must
  survive upgrades and agent restarts without stale metadata overwrites.
- Workspace cards must display Evicted and expose the existing Start action.

### Completion checklist

- [x] Reconcile current main without restoring obsolete cgroup configuration.
- [x] Integrate shared bounded Docker telemetry and numeric memory/PID parsing.
- [x] Fix and adversarially re-review eviction ownership, stop/retry, and lifecycle races.
- [x] Test generation/finalization migration and explicit restart admission/replay behavior.
- [x] Finish TypeScript lint/typecheck/test/build and quality/secret checks.
- [x] Finish Go unit/race/vet plus VM smoke/integration validation.
- [x] Complete desktop/mobile Playwright audit and post reviewed screenshots.
- [x] Obtain final Go, Cloudflare, security, resource, test, env, docs, constitution, completion reviews.
- [x] Coordinate staging ownership and deploy the pinned final candidate.
- [x] Provision one real VM; verify fresh heartbeat, workspace terminal, inherited cgroup boot
      configuration and agent survival under controlled stress, monitoring, eviction/restart,
      preserved workspace state, and callback behavior. Distinguish configuration evidence
      from direct runtime ancestry inspection; no cgroup design changes remain in this PR.
- [x] Delete this test's staging workspace/node with provider termination acknowledgment.
- [ ] Verify global zero staging VMs at rest; previous run's unresolved allocation remains.
- [ ] Update PR evidence, pass CI/SonarCloud, resolve CodeRabbit feedback.
- [ ] Merge #1980 and monitor production deployment.

### Review-driven recovery hardening

- Independent review found browser reconnect, legacy bootstrap, automatic recovery,
  and create replay could revive evicted containers after agent restart. Persist
  eviction state and fence every provisioning entry with the workspace lifecycle lock.
- Serialize snapshot/stop against restart; revalidate after snapshot-lock waits and
  pin the captured container identity so old work cannot snapshot or stop a successor.
- Persist a stop intent before irreversible Docker stop, then retain a token-free
  callback outbox across crashes. Retry one due item per heartbeat with a deadline,
  lease, single-delivery lock and capped backoff. Only confirmed stops reach the API.
- Persist project identity alongside generation for dynamic-workspace hydration;
  never infer a project or use unverified labels to authorize eviction.
- Current main was merged through `c2f035b35`; the additive D1 migration was later renumbered to
  `0164_workspace_eviction_fencing.sql` after main advanced with D1 migrations `0157`–`0163`.

### Current validation evidence (2026-09-13, implementation head f03c29e6d)

- Sequential root typecheck 19/19 and lint 13/13 passed; final API typecheck passed
  after the latest SDK update and module split. Final root build passed 9/9.
- API 77 focused tests and 33 real workerd tests passed, including actual D1/DO
  finalization. Module extraction also passed 31 lifecycle and 53 wiring tests.
- Deployment/quality scripts610/610 passed with one worker; initial concurrent fixture
  timeouts reproduced as load-only and passed unchanged when serialized.
- Structural quality suite15 commands, migration ordering, preflight, current-tree
  and PR-range secret scans passed (zero new secret findings).
- Real component Playwright mock audit passed mobile375x667/desktop1280x800 across
  normal/stress/empty/30-card scenarios. Fixed Unknown badge and cramped mobile title.
- Full Go race suite with coverage and vet passed. Docker bootstrap and ACP
  integration, VM E2E, and mock/Worker VM smoke passed. Final affected config,
  resource, persistence and server race suites passed, followed by focused tests
  for the behavior-preserving routing extraction.
- Full non-API TypeScript coverage passed, including web 308 files / 3,749 tests.
  Final API coverage passed: 718 files / 9,755 tests against the stable candidate.
- Independent completion review passed implementation and own VM verification;
  global zero-VM proof, final evidence/CI, CodeRabbit and merge remain open. Reviewed screenshots:
  https://github.com/raphaeltm/simple-agent-manager/pull/1980#issuecomment-5652096199
- Combined staging deployment, real VM heartbeat/terminal/agent access, OOM eviction,
  fresh snapshot capture, UI restart, overlay preservation and own cleanup passed.
  See [integration verification](../evidence/2026-09-13-vm-resource-management/verification.md).
  Global zero-VM proof remains pending for the previous run’s unresolved allocation.

### Shepherd completion follow-up (2026-09-14, after 18:00 UTC)

The eight CodeRabbit threads were still unresolved despite implementation fixes in
`1606e7749`. Independent API review found two remaining failure-path gaps: broad
workspace billing cleanup could close a successor interval, and a pre-dispatch
failure left `error` status so retry skipped evicted admission and billing.

- [x] Add real SQL regressions proving attempt-specific billing cleanup, successor
      preservation, failure/retry admission and metering, and ambiguous dispatch safety.
- [x] Restore the original evicted identity only before dispatch under the generation
      CAS; retain the new reservation and billing when dispatch outcome is uncertain.
- [x] Include boot-log and metering setup in failure handling; fail closed if metering fails.
- [x] Finish fresh root lint/typecheck/test/build, Go race/vet and independent API/completion re-review. Full Workers run tracked separately below.
- [x] Document and resolve every inherited CodeRabbit thread with exact evidence.
- [ ] Push the existing PR branch and observe fresh CI and CodeRabbit follow-up.
- [ ] Verify the final candidate on serialized staging and clean up owned resources.
- [ ] Prove provider-side zero VMs for the relevant prior user credential inventory;
      otherwise retain `needs-human-review` and the credential/infra blocker.

At 18:10 UTC the prior node row `01M2CX7B90KKPSJFPWJGX0JP6M` was absent and all
remaining VM node rows were deleted. Its workspace remains `stopping` with no node
attachment. An absent/deleted database row does not prove provider termination.
The earlier evidence's claim that the node is still destroying is historical.

---

_Archived 2026-09-23 by the weekly queue reconciliation. This work shipped: it landed on `main` via PR #1980 (`Layered VM resource management: cgroup isolation, monitoring, eviction (#1980)`). Its checklist reads 27/33 — the remaining boxes are stale. The audit verified the work, not the boxes, so they were left as-is rather than ticked without per-item evidence. Full evidence and method: `tasks/archive/2026-09-23-weekly-queue-reconciliation.md`._
