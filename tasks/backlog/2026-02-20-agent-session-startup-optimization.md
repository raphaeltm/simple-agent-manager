# Agent Session Startup Optimization

**Created**: 2026-02-20
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Large

## Context

There is a significant delay between `agent.websocket_connected` and `agent.ready`. Users experience a multi-second (sometimes 30+ second) wait after opening a chat session before they can interact with the agent. This delay is caused by a strictly sequential startup pipeline in `SessionHost.SelectAgent()` where every step blocks on the previous one, even when steps are independent.

## Current Startup Pipeline (Sequential)

The full sequence from WebSocket connection to agent ready:

```
Browser                              VM Agent                           Agent Process
  |                                    |                                   |
  |-- WebSocket connect -------------->|                                   |
  |                                    |-- resolveWorkspaceID              |
  |                                    |-- authenticateWebsocket           |
  |                                    |-- upsertWorkspaceRuntime          |
  |                                    |-- agentSessions.Create            |
  |                                    |-- getOrCreateSessionHost          |
  |                                    |-- upgrader.Upgrade                |
  |                                    |-- host.AttachViewer               |
  |<-- session_state{idle} ------------|                                   |
  |<-- session_replay_complete --------|                                   |
  |<-- session_state{idle} ------------|  (post-replay snapshot)           |
  |                                    |                                   |
  |-- select_agent{claude-code} ------>|                                   |
  |                                    |-- go SelectAgent()                |
  |<-- agent_status{starting} --------|                                   |
  |                                    |                                   |
  |                                    |-- [A] fetchAgentKey()   ~100-200ms|
  |                                    |-- [B] ensureAgentInstalled()      |
  |                                    |     docker exec which ...  ~50ms  |
  |                                    |     (if missing: npm install      |
  |<-- agent_status{installing} ------|      ~15-60 seconds!)             |
  |                                    |-- [C] fetchAgentSettings() ~100ms |
  |                                    |-- [D] ContainerResolver()   ~10ms |
  |                                    |-- [E] StartProcess()       ~300ms |
  |                                    |     docker exec -i ... acp-binary |
  |                                    |-- [F] ACP Initialize     ~200-500ms
  |                                    |-- [G] NewSession/LoadSession ~200ms
  |                                    |-- [H] SetSessionModel      ~50ms  |
  |                                    |-- [I] SetSessionMode       ~50ms  |
  |                                    |                                   |
  |<-- agent_status{ready} -----------|                                   |
```

**Total best-case (binary already installed)**: ~700-1200ms
**Total worst-case (first session, needs npm install)**: 15-60+ seconds

## Root Cause Analysis

### Problem 1: Sequential independent HTTP calls

`fetchAgentKey()` and `fetchAgentSettings()` are both independent HTTP POST calls to the control plane. They are currently run sequentially with the binary install check sandwiched between them.

**File**: `packages/vm-agent/internal/acp/session_host.go:295-330`

```go
// Step A: fetch credential (blocks)
cred, err := h.fetchAgentKey(ctx, agentType)

// Step B: install binary (blocks, depends on cred for getAgentCommandInfo)
info := getAgentCommandInfo(agentType, cred.credentialKind)
err := h.ensureAgentInstalled(ctx, info)

// Step C: fetch settings (blocks, independent of A and B)
settings := h.fetchAgentSettings(ctx, agentType)
```

### Problem 2: Binary install is the dominant cost and runs on-demand

The first time a user opens an agent session on a workspace, `ensureAgentInstalled` must run `npm install -g @zed-industries/claude-code-acp` inside the devcontainer. This is a 15-60+ second operation. It requires zero user-specific data (no credentials, no settings) — only a running devcontainer.

**File**: `packages/vm-agent/internal/acp/gateway.go:344-375`

### Problem 3: No pre-warming at workspace ready time

When a workspace finishes provisioning (`PrepareWorkspace` completes), the devcontainer is fully running but zero agent-related preparation happens. The user must wait for binary installation on their first `select_agent`.

**File**: `packages/vm-agent/internal/bootstrap/bootstrap.go:82-182` and `packages/vm-agent/internal/server/workspace_provisioning.go:53-100`

### Problem 4: Sequential ACP settings calls

`SetSessionModel` and `SetSessionMode` are independent ACP SDK calls run sequentially after NewSession.

**File**: `packages/vm-agent/internal/acp/session_host.go:741-773`

### Problem 5: No second-session pre-warming

When a user opens their first agent session, we know they're likely to open more (e.g., different agent type, or a new session tab). But we do nothing to prepare for this.

## Proposed Optimizations

### Phase 1: Parallelize Independent Steps in SelectAgent

**Impact**: Save ~100-200ms on every session start
**Risk**: Low
**Complexity**: Low

Currently in `SelectAgent()`:
```
A: fetchAgentKey      -> B: ensureAgentInstalled -> C: fetchAgentSettings -> D: startAgent
```

Optimized:
```
A: fetchAgentKey ─────┐
                      ├──> B: ensureAgentInstalled ──> D: startAgent
C: fetchAgentSettings ┘
```

Steps A and C are independent HTTP calls. Run them concurrently with `errgroup`. Step B depends on A's result (needs `credentialKind` for `getAgentCommandInfo`), but C does not depend on A or B.

Additionally, within `applySessionSettings`, `SetSessionModel` and `SetSessionMode` are independent and can be parallelized.

**Implementation**:

1. In `SelectAgent()` (`session_host.go:~252`), use `golang.org/x/sync/errgroup` to run `fetchAgentKey` and `fetchAgentSettings` concurrently:

```go
var cred *agentCredential
var settings *agentSettingsPayload

g, gctx := errgroup.WithContext(ctx)
g.Go(func() error {
    var err error
    cred, err = h.fetchAgentKey(gctx, agentType)
    return err
})
g.Go(func() error {
    settings = h.fetchAgentSettings(gctx, agentType)
    return nil // non-fatal
})
if err := g.Wait(); err != nil {
    // handle credential fetch failure
}
```

2. In `applySessionSettings()`, run `SetSessionModel` and `SetSessionMode` concurrently:

```go
var wg sync.WaitGroup
if settings.Model != "" {
    wg.Add(1)
    go func() {
        defer wg.Done()
        h.acpConn.SetSessionModel(ctx, ...)
    }()
}
if settings.PermissionMode != "" {
    wg.Add(1)
    go func() {
        defer wg.Done()
        h.acpConn.SetSessionMode(ctx, ...)
    }()
}
wg.Wait()
```

### Phase 2: Pre-install Agent Binaries at Workspace Ready Time

**Impact**: Eliminate 15-60+ second first-session delay
**Risk**: Low (install is idempotent, requires no credentials)
**Complexity**: Medium

After workspace provisioning completes (devcontainer is running), pre-install the default agent binary (`claude-code-acp`) in the background. This requires:

1. A new function `PreInstallAgentBinaries(ctx, containerID)` that installs the most common agent binary.
2. Hook it into the workspace provisioning completion path — either at the end of `PrepareWorkspace` / `provisionWorkspaceRuntime`, or as a background goroutine after workspace status transitions to `running`.
3. The install is already idempotent (`which` check first), so running it again in `ensureAgentInstalled` during `SelectAgent` is a no-op cache hit.

**Implementation**:

1. Extract agent binary info into a shared list accessible outside `SelectAgent`:

```go
// DefaultPreInstallAgents returns the agent binaries to pre-install at workspace ready time.
func DefaultPreInstallAgents() []agentCommandInfo {
    return []agentCommandInfo{
        {command: "claude-code-acp", installCmd: "npm install -g @zed-industries/claude-code-acp"},
    }
}
```

2. Add `PreInstallAgentBinaries(ctx context.Context, containerID string) error` to `packages/vm-agent/internal/acp/gateway.go` that iterates the list and calls `installAgentBinary` for each.

3. In `workspace_provisioning.go`, after `prepareWorkspaceForRuntime` succeeds and the workspace transitions to `running`, launch a background goroutine:

```go
go func() {
    containerID, err := containerResolver()
    if err != nil { return }
    if err := acp.PreInstallAgentBinaries(ctx, containerID); err != nil {
        log.Printf("Pre-install agent binaries failed (non-fatal): %v", err)
    }
}()
```

4. Add a boot log step so the user sees "Pre-installing agent tools" in the workspace boot log.

5. Add env var `AGENT_PREINSTALL_DISABLED` to allow disabling this behavior.

### Phase 3: Pre-fetch and Cache Credentials/Settings at Workspace Level

**Impact**: Save ~100-200ms per session start after the first
**Risk**: Low-Medium (needs cache invalidation strategy)
**Complexity**: Medium

Agent credentials and settings are per-user, not per-session. They can be fetched once when the workspace becomes ready and cached in `WorkspaceRuntime`.

**Implementation**:

1. Add credential/settings cache fields to `WorkspaceRuntime`:

```go
type WorkspaceRuntime struct {
    // ... existing fields ...
    
    // Cached agent data (guarded by mu)
    agentCredCache   map[string]*agentCredentialCacheEntry  // keyed by agentType
    agentSettCache   map[string]*agentSettingsCacheEntry     // keyed by agentType
}

type agentCredentialCacheEntry struct {
    cred      *agentCredential
    fetchedAt time.Time
}

type agentSettingsCacheEntry struct {
    settings  *agentSettingsPayload
    fetchedAt time.Time
}
```

2. Add configurable TTL via `AGENT_CREDENTIAL_CACHE_TTL` (default: 5 minutes) and `AGENT_SETTINGS_CACHE_TTL` (default: 5 minutes).

3. Modify `fetchAgentKey` and `fetchAgentSettings` on `SessionHost` to check the workspace-level cache first, with TTL-based expiry.

4. After workspace transitions to `running`, optionally pre-fetch credentials for the default agent type (requires knowing which agent the user prefers — could be fetched from agent settings endpoint).

### Phase 4: Pre-warm Next Session

**Impact**: Near-instant second session startup
**Risk**: Medium (resource usage for speculative work)
**Complexity**: Medium-High

When a user starts their first agent session, speculatively prepare for a second session by:

1. **Pre-verifying binary installation** for other known agent types (the `which` check is ~50ms, not the full install).

2. **Pre-resolving the container ID** — already cached by `container.Discovery` with 30s TTL, so this is essentially free after the first session.

3. **Warming the Node.js module cache** — after the first successful agent process spawn, the npm module cache is hot. Subsequent `docker exec` process spawns benefit from this automatically. No explicit action needed.

4. **NOT pre-spawning agent processes** — this would waste container resources and is speculative. The credential is user-specific and must match the agent type selected.

**Implementation**:

1. After `SelectAgent` completes successfully, run a background goroutine that checks `which` for all other known agent binaries. This populates the `docker exec` and filesystem caches:

```go
go func() {
    for _, info := range knownAgentBinaries() {
        if info.command == currentAgentCommand { continue }
        exec.CommandContext(ctx, "docker", "exec", containerID, "which", info.command).Run()
    }
}()
```

2. Track which agents have been verified as installed in the `WorkspaceRuntime` to avoid redundant checks.

## Implementation Plan

### Checklist

- [ ] **Phase 1a**: Parallelize `fetchAgentKey` + `fetchAgentSettings` with `errgroup`
- [ ] **Phase 1b**: Parallelize `SetSessionModel` + `SetSessionMode` with `sync.WaitGroup`
- [ ] **Phase 1 tests**: Unit tests verifying concurrent fetch and error handling
- [ ] **Phase 2a**: Extract `PreInstallAgentBinaries` function
- [ ] **Phase 2b**: Hook pre-install into workspace provisioning completion
- [ ] **Phase 2c**: Add `AGENT_PREINSTALL_DISABLED` env var
- [ ] **Phase 2 tests**: Unit tests for pre-install function, integration test for provisioning hook
- [ ] **Phase 3a**: Add credential/settings cache to `WorkspaceRuntime`
- [ ] **Phase 3b**: Wire cache into `fetchAgentKey` and `fetchAgentSettings`
- [ ] **Phase 3c**: Add `AGENT_CREDENTIAL_CACHE_TTL` / `AGENT_SETTINGS_CACHE_TTL` env vars
- [ ] **Phase 3 tests**: Unit tests for cache hit/miss/expiry behavior
- [ ] **Phase 4**: Background `which` checks for other agent binaries after first session
- [ ] **Phase 4 tests**: Verify background checks don't block or error
- [ ] **Documentation**: Update CLAUDE.md/AGENTS.md with new env vars
- [ ] **CI green**: All tests pass, lint/typecheck clean

## Affected Files

| File | What Changes |
|------|-------------|
| `packages/vm-agent/internal/acp/session_host.go` | Parallelize fetches in SelectAgent, parallelize settings in applySessionSettings, cache integration |
| `packages/vm-agent/internal/acp/gateway.go` | Extract PreInstallAgentBinaries, export agent binary list |
| `packages/vm-agent/internal/server/workspace_provisioning.go` | Hook pre-install after provisioning |
| `packages/vm-agent/internal/server/workspaces.go` | WorkspaceRuntime cache fields |
| `packages/vm-agent/internal/config/config.go` | New env vars: AGENT_PREINSTALL_DISABLED, cache TTLs |
| `packages/vm-agent/go.mod` | Add `golang.org/x/sync` dependency (for errgroup) |
| `CLAUDE.md` / `AGENTS.md` | Document new env vars |

## Testing Strategy

- **Unit tests**: Mock HTTP server for parallel fetch testing, cache TTL/expiry tests
- **Unit tests**: Pre-install function with mock container exec
- **Integration tests**: Full SelectAgent flow with timing assertions
- **Performance benchmarks**: Measure startup time before/after changes
- **Manual verification**: Deploy to staging, open agent session, measure time to ready

## Constitution Compliance

- All new timeouts/limits are configurable via environment variables with defaults
- No hardcoded URLs (uses existing `ControlPlaneURL` from config)
- Pre-install behavior is disable-able via `AGENT_PREINSTALL_DISABLED`
- Cache TTLs are configurable
