# Fix VM Agent Container Recovery From Debug Package Findings

## Problem

The debug package `debug-01KRDV2Y9RRTJTYTG7R9DFJ1N5.tar.gz` shows the VM agent pinned to a stale devcontainer ID after a devcontainer failure/fallback sequence:

- VM agent selected container `4b05ea54c91e` when two containers matched the workspace label.
- That container failed and was removed before fallback.
- Docker later showed the actual running container as `92cd9b569815`.
- The port scanner continued running `docker exec cat /proc/net/tcp` against `4b05ea54c91e` every five seconds, reaching 1,141 consecutive failures.
- The package also showed Hetzner apt mirror injection rewriting Ubuntu noble sources to `mirror.hetzner.com`, causing 404s during Playwright dependency installation.

Some related work landed in PR #966 and PR #968, but the VM-agent resilience gap remains: container discovery still trusts cached IDs within TTL, port scanning does not clear dead IDs, and multiple matching containers are selected by Docker output order.

## Research Findings

- `packages/vm-agent/internal/container/discovery.go`
  - `GetContainerID()` returns the cached ID within TTL without checking that the container still exists.
  - `discover()` uses `docker ps -q --filter label=...` and selects the first line when multiple containers match.
  - `GetBridgeIP()` can reuse a cached bridge IP without verifying it still belongs to the current cached container.

- `packages/vm-agent/internal/ports/scanner.go`
  - Lazy resolution only happens when `containerID == ""`.
  - Once a stale container ID is set, repeated `readProcNetTCP()` failures increment the counter but never clear the stale ID or call the resolver.
  - Existing tests cover initial lazy resolution but explicitly assert the resolver is never called when a container ID is present. That expectation needs to become more precise: resolver should not be called while the ID is healthy, but should be called after stale-container failures.

- `packages/vm-agent/internal/bootstrap/bootstrap.go`
  - `injectAptMirrorConfig()` rewrites Ubuntu sources to provider-specific mirror hostnames before package installs.
  - For Hetzner, `resolveAptMirror()` returns `mirror.hetzner.com`.
  - The debug package showed `http://mirror.hetzner.com/ubuntu noble Release` returning 404 inside the devcontainer.

- `packages/cloud-init/src/template.ts`
  - PR #968 already disabled apt timers and hardened IPv6 firewall setup.
  - The debug package root password/cron warning and cloud-init schema warning appear separate and lower priority than the stale-container failure path.

- Relevant post-mortems:
  - `docs/notes/2026-04-03-port-detection-recovery-status-postmortem.md`: port detection must work in recovery/fallback states; avoid inconsistent status derivation and add regression coverage.
  - `docs/notes/2026-05-04-devcontainer-gitconfig-lock-postmortem.md`: devcontainer provisioning has prior stale/concurrent state failures; shared helpers and retry/cleanup behavior are preferred over one-off command calls.
  - `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`: infrastructure changes require real VM provisioning/heartbeat verification.
  - `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`: review tracker must be durable and all specialist findings must be addressed before PR completion.

## Implementation Checklist

- [x] Add container discovery validation so cached container IDs are verified as still running before reuse.
- [x] Make multiple matching devcontainer selection deterministic, preferring the newest running container rather than Docker output order.
- [x] Ensure bridge IP cache is invalidated when the cached container changes or disappears.
- [x] Make the port scanner clear stale container IDs and re-resolve after container-not-found or stale-container scan failures.
- [x] Emit useful scanner diagnostics/events when a stale container ID is replaced.
- [x] Update port scanner tests to cover stale container recovery without weakening healthy-container behavior.
- [x] Add container discovery tests for cached ID validation, stale ID invalidation, and deterministic newest-container selection.
- [x] Harden apt mirror injection so an invalid/unavailable provider mirror does not leave containers with broken apt sources.
- [x] Add bootstrap tests for Hetzner mirror validation/fallback behavior.
- [x] Decide whether root password expiration and cloud-init schema warnings are actionable in this PR; if not, create/record follow-up backlog tasks.

## Implementation Notes

- Container discovery now validates cached container IDs with Docker before returning them, clears stale IDs, and chooses the newest matching running container by parsed creation time.
- Bridge IP cache entries are scoped to the container ID they were resolved from, so fallback containers cannot inherit stale network metadata.
- Port scanning now treats scan failures as possible stale-container signals, clears the cached ID, re-runs the configured resolver, and emits `port.scanner_container_changed` when a replacement is found.
- Provider apt mirror injection now backs up source files, rewrites them, validates the mirror through `apt-get update` using temporary list/cache directories, and restores the original sources if validation fails.
- Root password expiration and cloud-init schema warnings are not directly actionable in this PR: no repo-controlled `chpasswd`/root password template was found, and the existing active task `tasks/active/2026-05-12-vm-agent-cloud-init-firewall-hygiene.md` already records the remaining cloud-init/firewall hygiene track.

## Acceptance Criteria

- A port scanner with an initially valid but later removed container ID eventually resolves and scans the current running container.
- Container discovery does not return dead cached IDs.
- Multiple matching containers are selected deterministically, with tests proving the intended ordering.
- Hetzner mirror injection is non-destructive: if the mirror cannot serve the current distro sources, apt sources are restored or left untouched.
- Existing VM agent tests pass.
- Staging verification is completed to the extent possible through the deployment pipeline and, because this touches VM-agent infrastructure, a real staging VM provisioning/heartbeat test is attempted and documented.

## References

- Debug package: `/workspaces/.private/debug-01KRDV2Y9RRTJTYTG7R9DFJ1N5.tar.gz`
- PR #966: duplicate workspace dispatch guard
- PR #968: cloud-init apt timer and IPv6 firewall hygiene
- `docs/notes/2026-04-03-port-detection-recovery-status-postmortem.md`
- `docs/notes/2026-05-04-devcontainer-gitconfig-lock-postmortem.md`
- `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`
