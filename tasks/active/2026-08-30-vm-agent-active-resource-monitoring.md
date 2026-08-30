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
- [ ] Create a PR targeting `sam/layered-resource-management`.

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
