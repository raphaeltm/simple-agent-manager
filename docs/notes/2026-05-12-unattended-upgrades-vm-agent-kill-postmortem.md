# Post-Mortem: Unattended Upgrades Kill VM Agent Sessions

**Date:** 2026-05-12
**Severity:** High — active agent sessions killed silently
**Duration:** Intermittent; occurs whenever apt-daily-upgrade.timer fires (~06:30 UTC daily)

## What Broke

Agent sessions running on ephemeral VMs were silently killed. Users saw agents go offline while workspaces remained running. No error was surfaced — agents simply stopped responding.

## Root Cause

Ubuntu's `apt-daily-upgrade.timer` triggered `unattended-upgrades.service` at ~06:30 UTC. The package upgrade process triggered a `systemd daemon-reexec` (systemd reloaded itself), which restarted all services including `vm-agent.service`. The VM agent restart killed all active PTY sessions (agent processes) without graceful shutdown.

Timeline from debug package analysis:
- `06:30:59` — `apt-daily-upgrade.service` started
- `06:32:46` — `systemd[1]: Reexecuting.` (daemon-reexec)
- `06:32:50` — `Stopping vm-agent.service...`
- Both agent sessions killed immediately

## Why It Wasn't Caught

1. **No monitoring for systemd service restarts** — heartbeats continued after the VM agent restarted, masking the kill
2. **Ephemeral VM assumption** — the team assumed no system-level daemons would interfere with short-lived VMs, but `unattended-upgrades` runs on a timer, not just at boot
3. **No test coverage** — cloud-init templates had no test asserting that auto-update services were disabled

## Class of Bug

**Host-level daemon interference with application workloads on ephemeral VMs.** Any system service that triggers `systemd daemon-reexec` or restarts the application service will kill active sessions. This includes not just unattended-upgrades but potentially other system timers.

## Fix

Added commands to `packages/cloud-init/src/template.ts` runcmd section to disable:
- `apt-daily-upgrade.timer`
- `apt-daily.timer`
- `unattended-upgrades.service`

These VMs are ephemeral (hours, not months) — automatic package upgrades provide no security benefit and actively harm running workloads.

## Additional Fixes in This PR

Three additional production issues were discovered from the same debug package analysis:

1. **Duplicate workspace creation race** — TaskRunner DO and node-ready handler both dispatched the same workspace. Fixed by adding `dispatched_to_agent_at` column as a guard.
2. **Task callback 401 auth failures** — `projectsRoutes.use('/*', requireAuth())` leaked session auth to the callback route. Fixed by extracting the callback route into a separate Hono instance mounted before `projectsRoutes`.
3. **MCP token expiration** — 4h TTL with no renewal caused agents running >4h to lose MCP tools. Fixed with 8h TTL + sliding window (refresh on use, capped at 24h max lifetime).

## Process Fix

- Cloud-init template tests should assert that `unattended-upgrades` is disabled in the runcmd output
- Added `.claude/rules/06-api-patterns.md` documentation about Hono middleware scoping (already existed from prior incident — this is a third instance of the same bug class)
