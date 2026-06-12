# 03 — Node Lifecycle and OS Updates

**Last updated:** 2026-06-10

This is the most important doc in the set. The existing node substrate is built on an ephemerality assumption that app nodes invert. Reusing it naively will reproduce known production incidents in a worse form.

## The inverted assumptions

The current vm-agent/cloud-init stack assumes nodes are cattle that live hours, not months. Each baked-in assumption and its app-node inversion:

| # | Ephemeral assumption (today, verified in code) | App node reality |
|---|---|---|
| 1 | Unattended-upgrades and apt timers are **disabled** at boot (`packages/cloud-init/src/template.ts:34-38`) | An internet-exposed host running for months MUST receive security patches |
| 2 | Agent binary downloaded **once** at cloud-init; updating requires destroying nodes (`.claude/rules/27-vm-agent-staging-refresh.md`) | Long-lived nodes would run stale binaries against an API that deploys daily; need self-update or versioned contract |
| 3 | Agent is not restart-safe; a systemd daemon-reexec killing it was a production incident (2026-05-12) | The deployment agent must be designed to die and restart constantly without consequence |
| 4 | No reboot tolerance needed (nodes never reboot in their lifetime) | Kernel updates, provider maintenance, and resizes all reboot the node; the app must reconverge automatically |
| 5 | Reapers actively destroy nodes: warm-pool idle alarm, cron sweep, **max node lifetime** | These will destroy app nodes = outage + potential data loss; every reaper needs a role exemption (doc 08) |
| 6 | TLS cert, callback token, etc. provisioned once at boot | Anything with an expiry needs a renewal path on a node that outlives it (doc 08) |

## Incident history that constrains this design

**2026-05-12 — unattended-upgrades killed the vm-agent** (`tasks/backlog/2026-05-12-fix-vm-agent-stability.md`): Ubuntu's pre-installed `apt-daily-upgrade.timer` triggered `unattended-upgrades`, which caused a systemd daemon-reexec, which restarted the vm-agent service and killed all active agent sessions. The fix for workspace nodes was to disable the timers entirely in cloud-init (the right call for ephemeral VMs).

**Why this matters here:** for app nodes we cannot use that fix — we need the updates. So the failure mode must be eliminated on the other side: the agent must be **restart-safe** and the **containers must be independent of both the agent and the Docker daemon's restarts**.

Also relevant: cloud-init sets `package_update: false` / `package_upgrade: false` because apt operations blocked runcmd for 5–10 minutes (template.ts:14-17). App node provisioning can afford a slower boot; don't blindly inherit the skip.

## OS update posture for app nodes

1. **Security patches ON.** Enable `unattended-upgrades` configured for the security pocket. The threat model demands it: these hosts are long-lived and publicly routable.
2. **Hold back Docker engine packages** (`docker-ce`, `docker-ce-cli`, `containerd.io`) from automatic upgrade. Engine upgrades are applied deliberately, during a maintenance action, not by a timer at 6am.
3. **`live-restore: true` in `/etc/docker/daemon.json`.** Containers keep running across dockerd restarts. This, combined with restart-safe agent design, defuses the daemon-reexec incident class for app nodes: a reexec restarts the agent (harmless — it reconciles) and possibly dockerd (harmless — live-restore), and the app keeps serving.
4. **No automatic reboots.** `Unattended-Upgrade::Automatic-Reboot "false"`. Kernel updates accumulate.
5. **Surface "reboot required"** (`/var/run/reboot-required` + packages list) in the agent heartbeat → environment status in the UI. Reboots are user-triggered (or later, user-scheduled in a window). A reboot must be a non-event for the app (see below).
6. App-node cloud-init is a **variant** of the template, not a fork if avoidable: parameterize the update posture by role rather than maintaining two templates that drift.

## Restart-safe deployment agent (core design constraint)

The deployment agent must satisfy:

- **Desired state on disk.** The currently-applied release (manifest, rendered Compose, digests, route config) persists under e.g. `/var/lib/sam-deploy/desired/`. The agent process holds no state that matters.
- **Startup = reconcile.** On every start (boot, crash, update, reexec), the agent compares desired state to observed Docker state and converges. No special "first boot" vs "restart" paths.
- **systemd `Restart=always`**, with sane backoff.
- **Containers are not children of the agent.** They are managed by dockerd with `restart: unless-stopped` policies, so they survive agent death AND node reboot independently. The agent's job after a reboot is verification and route re-confirmation, not resurrection from scratch.
- **Apply operations are resumable or safely re-runnable.** If the agent dies mid-apply, the next start must detect the half-applied release and either complete or roll back to the last good release. Release directories + an atomically-updated "current" pointer (symlink or state file) give this.
- **Idempotent apply.** Applying the same release twice is a no-op.

Unit ordering: `docker.service` before `sam-deploy-agent.service`; agent tolerates Docker being briefly unavailable (retry, don't crash-loop into backoff exhaustion).

**Corollary — the agent must not be the data plane.** "Agent restarts are harmless" only holds if no user traffic flows *through* the agent. The workspace vm-agent terminates TLS and proxies traffic itself; app nodes must instead use a standalone reverse proxy that the agent merely configures (doc 05 "Inside the node"). Otherwise every self-update is an outage.

## Management-plane resource protection

A user's app can OOM or CPU-starve the node and take the agent, dockerd, and sshd down with it — making the node unmanageable exactly when it most needs management.

- **SAM injects default memory limits** on every service at render time (doc 06) when the manifest doesn't specify them, sized so the sum leaves headroom (e.g., total app memory ≤ ~80% of node RAM). Explicit user limits are validated against the same ceiling.
- **Protect the management plane via systemd**: `OOMScoreAdjust` favoring the agent/dockerd/sshd, and (optionally) a systemd slice with `MemoryMin` for management services. The agent surviving an app OOM event is what lets it report the OOM instead of going dark.
- OOM kills observed in container state are drift/status events (doc 08), not silent restarts.

## Firewall posture per role

Workspace nodes and app nodes need different inbound surfaces:

- **Workspace node (today):** agent port for control plane + proxied workspace traffic.
- **App node:** 443 (and optionally 80→redirect) open to the world for the data-plane proxy; the agent's management endpoint either restricted (Cloudflare IP ranges, as edge-proxied traffic is the only legitimate caller) or — if the pull-based command channel (doc 10) proves out — not exposed at all. Decide during slice 1; provision the firewall by role in cloud-init/provider config.

## Agent self-update

Options, with current leaning:

1. **(Leaning) Self-update channel:** control plane advertises the current agent version + R2 URL in heartbeat responses; agent downloads to a staging path, verifies checksum/signature, re-execs or restarts via systemd. Update is just another restart — which the design already makes safe. Needs: version pinning per node (don't fleet-update during an apply), rollback to previous binary on crash-loop.
2. **Versioned API contract only:** agents never update; the API supports all historical agent versions. Rejected as primary strategy — the API deploys daily and this creates an unbounded compatibility matrix. Some minimal version-tolerance is still needed (during rollout windows).
3. **Replace the node to update the agent:** correct for workspace nodes (rule 27), unacceptable as the *only* path for app nodes (every agent fix = app downtime + volume shuffle), but fine as the fallback for broken agents.

The self-update mechanism is also the answer for **Docker engine updates** and **reboots**: they become orchestrated maintenance actions reported through the same status surface.

## Binary distribution prerequisite

Today the binary lands on the node once via cloud-init from R2 (and rule 27 documents the staleness trap this creates even for staging tests). The self-update channel must reuse the same R2 artifact path + checksum the deploy pipeline already produces, and the control plane must record which version each node runs (heartbeat field) so the admin surface can show fleet version skew.

## `--role=deployment` vs separate binary

Leaning: **same binary, role flag** (doc 09 Q1). Rationale: reuses TLS bootstrap, heartbeats, callback auth, debug-package, logging, and the R2 distribution pipeline. The role gate must be hard: in deployment role, workspace/PTY/ACP endpoints are not just unused but **not registered**. Risks to watch: binary size/attack surface creep, and accidental shared code paths that assume workspaces exist. If the shared core gets fights, split later — a role flag is easy to migrate away from; a second distribution pipeline is not.
