# App-Deploy Day-2 Operations Status Model

## Problem Statement

Long-lived app deployment nodes are NOT workspace nodes. They need day-2 operational concerns:
- Container logs can fill the disk if unbounded
- Old Docker images accumulate without GC
- Heartbeat lacks disk/volume telemetry for early pressure warning
- No multi-dimensional status model (app health, node health, provider manageability, route/cert state, disk pressure, config drift are all mushed together or absent)

Missing day-2 work becomes production incidents.

## Research Findings

### Existing Code

1. **Heartbeat** (`packages/vm-agent/internal/server/health.go`): Sends `deployment` block with `ObservedState` (appliedSeq, status, errorMessage, services). Also sends `metrics` block with `cpuLoadAvg1`, `memoryPercent`, `diskPercent` from sysinfo QuickMetrics. **No volume-specific telemetry.**

2. **Compose renderer** (`apps/api/src/services/compose-renderer.ts`): Builds service dicts but does NOT add `logging` config. Docker daemon.json sets `log-driver: journald` globally for workspace nodes but deployment nodes may use different patterns with docker compose services.

3. **Deploy types** (`packages/vm-agent/internal/deploy/types.go`): `ObservedState` has appliedSeq, status, errorMessage, services. **No disk/volume/drift/provider dimensions.**

4. **SysInfo** (`packages/vm-agent/internal/sysinfo/sysinfo.go`): Has `collectDisk()` via `statFS` for a single mount path (defaults to `/`). Can be reused for volume telemetry.

5. **ResourceMon** (`packages/vm-agent/internal/resourcemon/monitor.go`): Collects disk for `/` only. Separate concern — persists to SQLite for historical analysis.

6. **No existing image GC code** anywhere in the codebase.

7. **Cloud-init template** sets Docker `log-driver: journald` in `daemon.json` for workspace nodes. Deployment nodes also get this via the same template. However, Compose services can override via per-service `logging` config.

### Key Design Decisions

- The `ObservedState` in `types.go` is the natural place to extend with the 6-dimension status model
- Image GC should be a standalone function callable from the engine or a background loop
- Compose renderer log rotation is a server-side concern (rendered into the compose YAML)
- Volume telemetry reuses the existing `sysinfo.collectDisk()` / `statFS` pattern for `/mnt/sam-env-*`
- **STAY OFF `engine.go`** — parallel branch is modifying it. Add new files instead.

## Implementation Checklist

### A. Status Model Types (Go)
- [x] Create `packages/vm-agent/internal/deploy/status.go` with 6-dimension status model types
- [x] Define `DeploymentStatus` struct with: AppHealth, NodeHealth, ProviderManageability, RouteCertState, DiskPressure, ConfigDrift
- [x] Each dimension is an independent enum (not derived from others)
- [x] Extend `ObservedState` to include the new status fields + disk telemetry
- [x] Add `DiskTelemetry` struct for root disk + data volume usage

### B. Bounded Container Log Rotation (TypeScript)
- [x] Add `logging` config to each service in `compose-renderer.ts` with `json-file` driver, `max-size: 10m`, `max-file: 3`
- [x] Make log rotation params configurable via `ComposeRenderContext` with defaults
- [x] Add tests verifying rendered compose includes logging config with correct values

### C. Rollback-Aware Image GC (Go)
- [x] Create `packages/vm-agent/internal/deploy/imagegc.go`
- [x] `PruneUnusedImages(currentSeq, previousSeq int64)` — prune images not referenced by current or previous releases
- [x] Use `docker image ls` to enumerate, `docker image rm` to remove
- [x] Parse release metadata from disk state to identify protected image digests
- [x] Add comprehensive tests with mock exec

### D. Heartbeat Disk/Volume Telemetry (Go)
- [x] Extend heartbeat payload in `health.go` to include disk telemetry for root (`/`) and data volume (`/mnt/sam-env-*`)
- [x] Use existing `sysinfo` collector pattern to collect volume stats
- [x] Include `DiskTelemetry` in the `deployment` block of the heartbeat

### E. Tests
- [x] Status model: each dimension independently settable
- [x] Image GC: preserves current+previous, prunes older
- [x] Log rotation: compose output includes bounded logging config
- [x] Heartbeat: payload includes disk+volume usage with realistic values

## Acceptance Criteria

- [ ] Status model has 6 independent dimensions, each with its own enum
- [ ] Provider-cred loss surfaces `management-degraded` without flipping app-health
- [ ] Compose renderer adds bounded log rotation to every service
- [ ] Image GC never prunes current or previous (rollback-target) release images
- [ ] Heartbeat includes root disk AND data volume usage in bytes and percent
- [ ] All tests pass locally
- [ ] No changes to `engine.go` or `deployment-routing.ts`
