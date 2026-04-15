# Resource Diagnostics on Workspace Build Timeout

## Problem

When a workspace build times out (30-min bootstrap timeout), the user gets a generic "context deadline exceeded" error with no actionable guidance. Users have no way to know if the timeout was caused by an under-resourced VM.

## Research Findings

### Error path in `startWorkspaceProvision()` (workspaces.go:226-245)
- On provisioning failure, the code calls `notifyWorkspaceProvisioningFailed()` with `err.Error()` as the message
- The error message is sent to the API and stored in D1 `workspaces.errorMessage`
- The UI already displays this in `ProvisioningIndicator.tsx`
- The timeout comes from `provisionWorkspaceRuntime()` which uses `context.WithTimeout(ctx, s.config.BootstrapTimeout)` (workspace_provisioning.go:79-81)

### `sysInfoCollector` on Server (server.go:52)
- `s.sysInfoCollector` is a `*sysinfo.Collector` field on the Server struct
- `CollectQuick()` returns `*QuickMetrics` with `CPULoadAvg1`, `MemoryPercent`, `DiskPercent`
- procfs-based, microsecond latency, safe to call under heavy load
- `QuickMetrics` does NOT include core count — need `runtime.NumCPU()` separately

### Node events via `appendNodeEvent()`
- Already used in the error path (workspaces.go:244) with a `failureDetail` map
- Can add `resourceDiagnostics` key to the detail map

### No API/UI changes needed
- `notifyWorkspaceProvisioningFailed()` already accepts an `errorMessage` string
- `ProvisioningIndicator.tsx` renders the error message as-is

## Implementation Checklist

- [x] Create `buildTimeoutDiagnostics()` function in workspaces.go that:
  - Takes the original error and returns an enriched error message string
  - Checks `errors.Is(err, context.DeadlineExceeded)` — returns original error message if not a timeout
  - Calls `s.sysInfoCollector.CollectQuick()` to get resource metrics
  - Uses `runtime.NumCPU()` for per-core CPU load calculation
  - Applies heuristics: CPU saturated (loadAvg1/numCPU > 2.0), memory exhausted (>90%), disk full (>90%)
  - Builds diagnostic message with raw metrics and actionable suggestion
  - Handles sysinfo collection failure gracefully (returns original error message)
- [x] Modify error path in `startWorkspaceProvision()` to use enriched message for `notifyWorkspaceProvisioningFailed()`
- [x] Add `resourceDiagnostics` to node event detail map with raw metrics
- [x] Add unit tests:
  - Timeout error + high resource usage → diagnostic message generated
  - Timeout error + normal resource usage → diagnostic message with metrics but no "under-resourced" suggestion
  - Non-timeout error → no resource diagnostics appended
  - Sysinfo collection failure → falls back to original error message
  - Wrapped timeout error → diagnostics still triggered
  - Disk full only → correct constraint message
- [x] Verify no API or UI changes needed (existing errorMessage field and ProvisioningIndicator handle it)

## Acceptance Criteria

- [x] When provisioning times out with high resource usage, the error message includes resource metrics and suggests a larger VM
- [x] When provisioning times out with normal resource usage, the error message includes resource metrics but does not suggest a larger VM
- [x] When provisioning fails for non-timeout reasons, the error message is unchanged
- [x] If sysinfo collection fails, the original error message is preserved (no masking)
- [x] Resource diagnostics appear in node events for observability
- [x] All new code has unit tests

## References

- `packages/vm-agent/internal/server/workspaces.go` — `startWorkspaceProvision()` error path
- `packages/vm-agent/internal/server/workspace_provisioning.go` — timeout setup
- `packages/vm-agent/internal/server/workspace_callbacks.go` — `notifyWorkspaceProvisioningFailed()`
- `packages/vm-agent/internal/sysinfo/sysinfo.go` — `CollectQuick()`, `QuickMetrics`
- `packages/vm-agent/internal/server/server.go` — `sysInfoCollector` field
