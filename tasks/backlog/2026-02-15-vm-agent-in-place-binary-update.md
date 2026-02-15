# VM Agent In-Place Binary Update Feature

**Status:** backlog  
**Priority:** medium  
**Estimated Effort:** 2 weeks  
**Created:** 2026-02-15

## Problem Statement

Currently, updating the VM Agent binary requires destroying and recreating the entire node, which forces users to:
- Delete all workspaces on the node
- Lose all workspace state and session history
- Re-provision the node from scratch (5-10 minutes)
- Recreate all workspaces

This is disruptive and time-consuming for users who want to benefit from VM Agent bug fixes and new features.

## Proposed Solution

Enable users to update the VM Agent binary on running nodes through the control plane UI, preserving all workspaces and session state. Add a "Check for Updates" button on the Node detail page that triggers a graceful self-replacement of the running VM Agent process.

## Research Summary

Based on 2026 best practices for self-updating Go binaries and graceful process replacement:

### Recommended Libraries
- **[rhysd/go-github-selfupdate](https://github.com/rhysd/go-github-selfupdate)** - GitHub Releases integration with SHA256/ECDSA validation
- **[creativeprojects/go-selfupdate](https://github.com/creativeprojects/go-selfupdate)** - Multi-source support (GitHub, GitLab, Gitea, local files)
- **[minio/selfupdate](https://github.com/minio/selfupdate)** - Flexible with binary patching and code signing

### Process Replacement Approaches

**Option 1: systemd-notify + Exec** (Zero-downtime, complex)
- Use `Type=notify-reload` in systemd unit
- Call `syscall.Exec()` to replace process while preserving file descriptors
- systemd tracks upgrade lifecycle
- **Best for:** Production-critical services needing zero connection drops

**Option 2: Fork-Exec** (Near-zero downtime, moderate complexity)
- Fork child with new binary, pass socket FDs via `ExtraFiles`
- Child takes over connections, parent drains and exits
- **Best for:** Services needing connection preservation

**Option 3: Simple Restart** (Brief downtime, simplest) ⭐ **RECOMMENDED FOR MVP**
- Download, verify, replace binary
- Call `systemctl restart vm-agent`
- 1-2 second downtime
- **Best for:** MVP where browser auto-reconnects and sessions restore

**Rationale for Option 3:**
- SAM already handles WebSocket reconnection gracefully (PTY session recovery)
- ACP sessions restore conversation via LoadSession
- 1-2s downtime acceptable for manual admin action
- Significantly simpler to implement and test
- Can iterate to zero-downtime later if needed

### Security Best Practices
From **[Cloudflare ecdysis](https://noise.getoto.net/2026/02/13/shedding-old-code-with-ecdysis-graceful-restarts-for-rust-services-at-cloudflare/)** and Go self-update libraries:

1. **Version validation**: Semantic versioning for systematic comparison
2. **Signature verification**: SHA256 checksums (MVP) → ECDSA signatures (future)
3. **Atomic replacement**: Download to temp, verify, then atomically move
4. **Rollback support**: Keep previous binary as backup
5. **No downgrades**: Reject updates to older versions

## Implementation Plan

### Phase 1: Backend Infrastructure

#### 1. Binary Versioning
- Embed version at build time: `-ldflags "-X main.Version=$(git describe --tags)"`
- Add `GET /version` endpoint: `{"version": "v1.2.3", "commit": "abc123"}`
- **Files:** `packages/vm-agent/main.go`, `.github/workflows/deploy.yml`

#### 2. Binary Distribution Metadata
- Add `GET /api/agent/latest-version` endpoint:
  ```json
  {
    "version": "v1.2.3",
    "checksums": {
      "amd64": "sha256:abc123...",
      "arm64": "sha256:def456..."
    },
    "published_at": "2026-02-15T12:00:00Z"
  }
  ```
- Generate checksums during deployment and upload to R2
- **Files:** `apps/api/src/routes/agent.ts`, `.github/workflows/deploy.yml`

#### 3. VM Agent Update Endpoint
- **New:** `POST /update` on VM Agent (authenticated with callback token)
- **Request:** `{"version": "v1.2.3"}` (optional, defaults to latest)
- **Response:** `{"status": "downloading|verifying|restarting|completed", "message": "..."}`
- **Logic:**
  1. Fetch latest version metadata from control plane
  2. Compare with current version (reject if not newer)
  3. Download binary to `/tmp/vm-agent.new`
  4. Verify SHA256 checksum
  5. Make executable, atomically move to `/usr/local/bin/vm-agent`
  6. Call `exec.Command("systemctl", "restart", "vm-agent").Run()`
  7. Return response before restart
- **Files:** `packages/vm-agent/internal/server/routes.go`, `packages/vm-agent/internal/update/updater.go` (new)

#### 4. Control Plane Trigger Endpoint
- **New:** `POST /api/nodes/:id/update-agent` (authenticated, owner-only)
- **Response:** `{"status": "initiated", "target_version": "v1.2.3"}`
- **Logic:** Proxy request to VM Agent `POST /update` via `http://vm-{node_id}.{BASE_DOMAIN}/update`
- **Files:** `apps/api/src/routes/nodes.ts`

### Phase 2: UI Integration

#### 1. Node Detail Page
- **Create/Enhance:** `apps/web/src/pages/NodeDetail.tsx`
- **Add:**
  - Current VM Agent version display
  - "Check for Updates" button (disabled if no newer version available)
  - Update progress indicator
  - Confirmation dialog: "This will restart the VM Agent. Active sessions will reconnect automatically. Continue?"
- **Files:** `apps/web/src/pages/NodeDetail.tsx`, `apps/web/src/components/NodeUpdateButton.tsx` (new)

#### 2. API Client Functions
- Add to `apps/web/src/lib/api.ts`:
  ```typescript
  export async function getNodeVersion(nodeId: string): Promise<{
    current: string;
    latest: string;
    updateAvailable: boolean;
  }>;
  
  export async function updateNodeAgent(nodeId: string): Promise<void>;
  ```

### Phase 3: Safety & Observability

#### 1. Pre-Update Validation
- **Check:** VM Agent health status (must be "healthy")
- **Check:** No workspaces in transitional states ("creating", "stopping")
- **Warn:** List active workspaces that will experience brief interruption

#### 2. Event Logging
- Log update lifecycle events to CF Workers observability:
  - Update initiated (user, node, current version, target version)
  - Download started/completed
  - Checksum verification passed/failed
  - Restart triggered
  - Post-restart health check passed/failed
- **Files:** `packages/vm-agent/internal/update/updater.go`

#### 3. Rollback Plan (Future Enhancement)
- Keep previous binary as `/usr/local/bin/vm-agent.backup`
- Systemd unit enhancement: if health check fails 3× in 30s, revert to backup
- Requires `ExecStartPre` health check script

## Testing Strategy

### Unit Tests
- [ ] Version comparison logic (semantic versioning)
- [ ] SHA256 checksum verification
- [ ] Download + verify workflow (mocked HTTP)
- [ ] Update rejection for older/same versions

### Integration Tests
- [ ] Full update flow in test VM
- [ ] Workspace containers survive update (not deleted)
- [ ] PTY sessions auto-reconnect after update
- [ ] ACP sessions restore conversation via LoadSession
- [ ] Download failure handling
- [ ] Checksum mismatch handling
- [ ] Health check failure after update

### Manual Testing Checklist
- [ ] Update node with no workspaces (baseline)
- [ ] Update node with stopped workspace
- [ ] Update node with running workspace (container survives)
- [ ] Update node with active PTY session (reconnects)
- [ ] Update node with active agent session (LoadSession restores)
- [ ] Update fails gracefully on download error
- [ ] Update fails gracefully on checksum mismatch
- [ ] Update blocked when node is unhealthy

## Security Considerations

### Threat Model
| Threat | Mitigation |
|--------|------------|
| **Malicious binary injection** (attacker replaces R2 binary) | SHA256 checksum verification against trusted metadata endpoint. Future: ECDSA signatures. |
| **Unauthorized update trigger** (attacker updates victim's node) | Require authenticated session token + node ownership verification in API |
| **Downgrade attack** (force old vulnerable binary) | Reject updates to versions ≤ current version (semantic versioning) |

### Authentication Flow
1. User clicks "Update" in UI (authenticated session)
2. UI → `POST /api/nodes/:id/update-agent` (session token)
3. API verifies user owns the node
4. API → VM Agent `POST /update` (callback token - node-scoped JWT)
5. VM Agent verifies callback token signature
6. VM Agent downloads from control plane (trusted source)
7. VM Agent verifies checksum before replacing binary

## Success Criteria
- [ ] Users can update VM Agent without node recreation
- [ ] Workspaces survive update (Docker containers not destroyed)
- [ ] Active PTY sessions auto-reconnect within 5 seconds
- [ ] Active agent sessions restore conversation context via LoadSession
- [ ] Update completes in <30 seconds
- [ ] Clear error messages for all failure modes
- [ ] Update events visible in node event log

## Future Enhancements
- **Auto-update:** Optional automatic updates on new releases
- **Zero-downtime:** Implement fork-exec or exec-based replacement (Options 1/2)
- **Update scheduling:** Schedule updates for specific times
- **Batch updates:** "Update all nodes" button
- **Notifications:** In-app alerts for new VM Agent versions
- **ECDSA signatures:** Code signing with private key in CI, public key in binary

## Technical References

Based on 2026 best practices research:

- [rhysd/go-github-selfupdate](https://github.com/rhysd/go-github-selfupdate) - Binary self-update for Go
- [creativeprojects/go-selfupdate](https://github.com/creativeprojects/go-selfupdate) - Multi-source self-update library
- [minio/selfupdate](https://github.com/minio/selfupdate) - Minio's self-update implementation with binary patching
- [Cloudflare ecdysis](https://noise.getoto.net/2026/02/13/shedding-old-code-with-ecdysis-graceful-restarts-for-rust-services-at-cloudflare/) - Production-hardened graceful restart patterns
- [systemd.service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) - Service configuration for notify/reload
- [Go binary self-replacement gist](https://gist.github.com/fenollp/7e31e6462b10c96aef443351bce6aea7) - syscall.Exec patterns

## Estimated Effort
- Backend (versioning, endpoints, update logic): 3-4 days
- UI (node detail page, update button, dialogs): 2-3 days
- Testing & validation: 2-3 days
- Documentation: 1 day
- **Total: ~2 weeks** (single developer, full-time)

## Dependencies
None - can be implemented independently of other features.

## Risks & Mitigations
| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Update corrupts binary | High | Low | Atomic replacement + SHA256 verification |
| New binary crashes on start | High | Medium | systemd auto-restart + future rollback mechanism |
| Workspace data loss | Critical | Very Low | Update only replaces binary, not Docker volumes |
| Race condition (concurrent updates) | Medium | Low | Update lock mechanism, reject concurrent requests |
| Network failure during download | Low | Medium | Clear error message, retry mechanism |

## Related Tasks
- None currently

## Notes
- Current workaround: Users must destroy and recreate nodes to get VM Agent updates
- This causes 5-10 minute downtime and loses all workspace state
- Real-world trigger: Bug fix deployed today (ANTHROPIC_MODEL env var) requires node recreation
- User feedback: "Can you write up a task for a feature that would allow updating the VM Agent without destroying the node?"

---

**Next Steps:**
1. Review and approve this task definition
2. Move to `tasks/active/` when ready to implement
3. Consider priority relative to other backlog items
