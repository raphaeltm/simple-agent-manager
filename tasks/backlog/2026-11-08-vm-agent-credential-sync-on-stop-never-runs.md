# VM agent never syncs auth.json back on session stop

## Problem

`SessionHost.syncCredentialOnStop` (`packages/vm-agent/internal/acp/session_host_lifecycle.go`)
is meant to send a refreshed file-based credential (Codex `~/.codex/auth.json`) back to the
control plane after the agent process exits. It never does.

Both stop paths call `stopCurrentAgentLocked()` before building the `credSyncSnapshot`:

- `session_host.go` (the stop path near line 590): `setStatusLocked(HostStopped)`, then
  `stopCurrentAgentLocked()`, then `snap := credSyncSnapshot{injectionMode: h.credInjectionMode, ...}`.
- `session_host_lifecycle.go` (the suspend path near line 147): same order.

`stopCurrentAgentLocked()` clears `h.credInjectionMode`, `h.credAuthFilePath` and `h.credKind`
(`session_host.go:703`). The snapshot therefore always has an empty injection mode, and
`syncCredentialOnStop` returns at its first check without logging anything.

The existing tests (`TestSyncCredentialOnStop_*` in `session_host_test.go`) call
`syncCredentialOnStop` directly with a hand-built snapshot, so none of them can see the order
in `Stop` (rule 62).

## Context

Found on staging on 2026-11-08 while verifying PR #2580 (Codex refresh respects account pins).
A pinned Codex VM session was refreshed through the proxy and then stopped through
`POST /api/workspaces/:id/agent-sessions/:sessionId/stop`. The VM agent logged the process stop
and exit, and nothing else: no sync attempt, no warning, and no `agent-credential-sync` request
reached the API.

Impact today: refreshes go through the refresh proxy, which persists the rotation itself, so
the dead sync loses nothing on the default path. It matters when the proxy is switched off
(`CODEX_REFRESH_PROXY_ENABLED=false`) or Codex refreshes directly: then nothing writes the
rotated token back.

## Ordering constraint

Fixing this turns the sync on for every session stop, including runs that never refreshed and
still hold a generation another run has rotated away. Ship it only after PR #2580, whose API
route refuses an older generation (`isStaleCodexSync`). Without that guard, enabling the sync
would let a stopping run overwrite a newer rotation with a consumed refresh token.

## Acceptance Criteria

- [ ] Both stop paths take the credential snapshot before `stopCurrentAgentLocked()` clears it
      (or the clear moves after the snapshot), and the snapshot is still taken under `h.mu`.
- [ ] A test drives the real `Stop` and suspend paths with auth-file injection and asserts the
      syncer is called once with the container's file; proven red against the current order.
- [ ] Control: env-var injection still does not sync.
- [ ] Staging: a Codex VM session stop produces an `agent-credential-sync` request, and a run
      holding an older generation is refused as `credential_stale` with the stored row unchanged.
- [ ] VM agent rollout rules (54, 27) followed.
