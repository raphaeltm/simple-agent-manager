# Local System Smoke Tests

This guide describes the closest practical local approximation to end-to-end testing for the VM Agent + ACP stack, without real DNS records or real cloud VMs.

## Why this exists

Real end-to-end testing in this project depends on:

- Cloudflare DNS + edge routing
- Hetzner VM lifecycle
- devcontainers booting inside those VMs

That full path is best validated in staging. This harness validates the core runtime boundaries locally:

- Terminal WebSocket auth and PTY execution
- ACP WebSocket agent selection and subprocess wiring
- VM Agent -> control plane callbacks (`/api/workspaces/:id/agent-key`, `/api/workspaces/:id/runtime`)
- VM Agent container discovery + `docker exec` into a workspace container

## Test topology

The smoke test starts:

1. A **mock workspace container** via Docker Compose (`scripts/e2e/docker-compose.vm-agent.yml`)
2. A **control-plane endpoint**:
   - `mock` mode: in-process Node HTTP server
   - `worker` mode: local Wrangler worker started via `unstable_startWorker`
3. The real **Go VM Agent** process (`packages/vm-agent`)

Then it runs two checks:

1. **Terminal smoke**
   - Creates a valid JWT terminal token
   - Connects to `ws://127.0.0.1:18080/terminal/ws?token=...`
   - Executes `echo terminal-smoke`
   - Verifies output is returned over WS

2. **ACP smoke**
   - Connects to `ws://127.0.0.1:18080/agent/ws?token=...`
   - Sends `select_agent` for `claude-code`
   - Verifies `agent_status: starting` then `agent_status: ready`
   - Sends `session/prompt`
   - Verifies a `session/update` event returns from the mocked ACP agent

## Run it

From repo root:

```bash
pnpm test:e2e:vm-agent-smoke
```

To run against a local Wrangler worker control-plane:

```bash
pnpm test:e2e:vm-agent-smoke:worker
```

You can also select mode with an env var:

```bash
E2E_CONTROL_PLANE=worker pnpm test:e2e:vm-agent-smoke
```

## Files

- `scripts/e2e/vm-agent-smoke.mjs` - orchestration and assertions
- `scripts/e2e/control-plane-worker.mjs` - Wrangler control-plane fixture for `worker` mode
- `scripts/e2e/docker-compose.vm-agent.yml` - workspace container dependency
- `scripts/e2e/workspace-mock/Dockerfile` - mock workspace image
- `scripts/e2e/workspace-mock/mock-acp-agent.sh` - mock ACP binary (`claude-code-acp`, `codex-acp`, `gemini`)

## CI

GitHub Actions runs both smoke profiles on pull requests to `main` via `.github/workflows/e2e-smoke.yml`:

- `mock` control-plane mode
- `worker` control-plane mode

## What this does not cover

- Real Cloudflare Workers/D1/KV/R2 behavior
- Real Cloudflare DNS routing and wildcard hostnames
- Real Hetzner provisioning/deletion lifecycle
- Real Claude/Codex/Gemini network calls and provider auth

Use staging deployment for those validation points.
