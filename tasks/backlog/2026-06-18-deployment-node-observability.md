# Deployment-node observability: app/container logs + deployment-page metrics

**Target branch:** `app-deployment-phase-d-control-surface` (PR #1356). **Do NOT merge to main/prod.** All work lands on this PR branch, tested + verified on staging, left inspectable.

## Problem (user)

Agents (and humans) need insight into how a *deployed app* runs — logs + performance metrics. Today:
- "Logs" buttons on the deployment/environment page and the node page show nothing useful for deployed apps.
- No performance metrics are visible on the deployment/environment page.
- On agent nodes you can see running containers and node-wide logs, but not per-container logs.

The ask: make **app/container logs** appear, and surface **node-level metrics at minimum, ideally per-container** for deployment nodes. (MCP exposure is explicitly out of scope for now — human visibility first.)

## Evidence gathered (live staging, 2026-06-18)

Verified against the running staging deployment node `01KVDPQT40MPCKC1ZTBHRBH237` (env `01KVDPQNHT88N9WRJQ8ENBH022`, project `01KJNR9R3TEN3KX1ETE33852R8`, owner `toWzGjNW3...`) via CF API (`$CF_TOKEN`) and authenticated curl (token-login → session cookie).

| Capability | State | Evidence |
|---|---|---|
| Backend DNS reachability (`{nodeId}.vm.sammy.party:8443`) | **FIXED on this branch today** | Node has `backend_dns_record_id`, recent heartbeat; deployment-env `/logs` now returns data. The 3 DNS self-heal commits (59c3dbbe/6d7ce314/bbfef071) created it. Before these, all logs/metrics returned `node_agent_unreachable`. |
| Node-level metrics | **ALREADY WORK** | `GET /api/nodes/:id/system-info` returns full CPU/mem/disk/network/uptime. Node page `SystemResourcesSection` renders it (same nodeId path for deployment nodes). |
| Container-level metrics | **ALREADY WORK** | `system-info` `docker.containerList[]` has per-container `cpuPercent`, `memUsage`, `memPercent`, `state`, `image`. Live: `1-web-1` nginx, mem 3.49MiB/256MiB (1.36%), running. |
| Node logs | Work, but **agent-only** | `GET /api/nodes/:id/logs` returns 200 entries, all `source:agent` (VM-agent slog). No container lines. |
| Deployment-env logs | Work, but **agent-only** | `GET /api/projects/:p/environments/:e/logs` returns VM-agent logs ("deploy: signing public key refreshed…"). |
| **App/container logs (`source=docker`)** | **BROKEN — 0 entries** | Both node `/logs?source=docker` and env `/logs?source=docker` return empty. This is the core gap. |
| Deployment/environment page metrics | **MISSING UI** | `DeploymentEnvironmentCard` renders logs only — no node or container metrics panel, despite the data existing. |

### Root cause of empty container logs (definitive)

- `apps/api/src/services/compose-renderer.ts:191-198` unconditionally sets every deployed service's `logging.driver = 'json-file'` (max-size 10m, max-file 3) — a deliberate rotation choice "to prevent unbounded log growth."
- `packages/vm-agent/internal/logreader/reader.go:232-272` `readDockerLogs` reads container logs **only from journald** (`journalctl _TRANSPORT=journal CONTAINER_NAME=…`). On error/empty it silently returns `nil,nil,nil` (line ~267).
- The cloud-init node-wide `/etc/docker/daemon.json` (`packages/cloud-init/src/template.ts:337-347`) sets the node default driver to `journald`, but the per-service `json-file` override in the rendered compose wins.
- **Result:** deployed app containers log to json-file; the journald-only reader finds nothing → `source=docker` returns 0. Confirmed via debug package: container `/1-web-1` `HostConfig.LogConfig.Type = json-file`.

## Plan (3 work items)

### W1 — App/container logs (CORE)
Add a json-file-aware container-log path to the VM-agent logreader for the `docker` source. Prefer reading via `docker logs <container>` / `docker compose -p <project> logs` (honors the json-file driver) instead of journald, with:
- Per-container filtering (`container` param) and a list-containers capability so the UI can offer a picker.
- `--since` / `--tail` / cursor-equivalent for pagination, and follow/stream support for `/logs/stream`.
- Keep the journald path for `agent`/`system`/`cloud-init` sources.
- Do NOT swallow errors silently — log at warn with container name + stderr (rule 39: make it observable).
- **Rejected alternative:** switch compose-renderer to `journald` driver. Loses deliberate per-container rotation and pollutes the system journal. Reading json-file via `docker logs` preserves the rotation choice and enables true per-container selection (directly fixes the "only node-wide logs" complaint).

Wire-through: node `/logs` + deployment-env `/logs` already pass the query string through to the agent (`deployment-environments.ts:319-326`, `nodes.ts:434-457`) — they just need the agent side to return docker entries. Add a container selector to `LogsSection` (node page) and the deployment-env logs panel.

### W2 — Deployment/environment page metrics UI
The data already exists; surface it.
- Backend: add a deployment-env-scoped metrics endpoint that proxies the node's `/system-info` (owner-checked, same pattern as the env logs route). Reuse `getNodeSystemInfoFromNode`.
- Frontend: add a metrics panel to `DeploymentEnvironmentCard` — node CPU/mem/disk + a per-container table (cpu%, mem, state) from `docker.containerList`. Poll while running; fall back to heartbeat `last_metrics` when the agent is briefly unreachable.

### W3 — Node page parity for deployment nodes
Confirm `SystemResourcesSection` + `LogsSection` render for `node_role=deployment` nodes (data endpoints already work) and that W1 container logs + the container picker appear there too. Mostly verification + reuse of the W1 selector.

## Testing requirements
- Vertical-slice tests (rule 35): logreader docker-logs path with mocked `exec` returning realistic json-file output + container list; deployment-env metrics route with mocked `getNodeSystemInfoFromNode`.
- Cross-boundary: assert node `/logs?source=docker` and env `/logs?source=docker` return container entries; assert the env metrics route returns node + container metrics.
- Playwright visual audit (rule 17) for the new metrics panel + container picker, mobile (375) + desktop (1280).
- **Staging (rule 27 — vm-agent changed):** delete all nodes, redeploy branch to staging, provision a fresh deployment node, deploy an app, then confirm container logs appear (`source=docker` non-empty) and node + container metrics render on the deployment page. Leave it inspectable.

## Constraints
- Land everything on `app-deployment-phase-d-control-surface` (push to that branch / PR #1356). **Never merge to main or deploy to production.**
- Keep PR in draft / do-not-merge state.
