# Cloudflare Sandbox SDK Prototype for SAM Agents

## Problem Statement

SAM's top-level agent (SamSession DO) and project-level agent (ProjectAgent DO) currently have no file system or CLI access — they can only reach code via the GitHub API, which is slow and rate-limited. Cloudflare's Sandbox SDK (`@cloudflare/sandbox`) provides exec, file I/O, git checkout, terminal/PTY, and backup/restore on top of Containers — potentially enabling these agents to clone repos, run commands, and edit files without provisioning full Hetzner VMs.

This task prototypes and measures these capabilities behind an admin-only test route.

## Research Findings

### Sandbox SDK API (from official docs)
- **Package:** `@cloudflare/sandbox` (v0.7.20, active development)
- **Import:** `import { getSandbox } from "@cloudflare/sandbox";`
- **Wrangler binding:** `[[containers]]` with `class_name = "Sandbox"`, `image = "./Dockerfile"`, `instance_type` setting
- **Key methods:**
  - `sandbox.exec(command, { cwd, timeout, env, stdin })` → `{ stdout, stderr, exitCode, success }`
  - `sandbox.execStream(command, opts)` → `ReadableStream` of SSE events
  - `sandbox.writeFile(path, content)` / `sandbox.readFile(path)` → `{ content }`
  - `sandbox.exists(path)` → `{ exists: boolean }`
  - `sandbox.mkdir(path, { recursive })`
  - `sandbox.gitCheckout(repoUrl, { branch, targetDir, depth })`
  - `sandbox.terminal(request, { cols, rows })` → WebSocket Response
  - `sandbox.createBackup({ dir, name, ttl, useGitignore })` → `{ id, dir }`
  - `sandbox.restoreBackup(backup)` → `{ success, dir, id }`
  - `sandbox.startProcess(command)` → Process with kill/getLogs/waitForPort
- **Options:** `keepAlive`, `sleepAfter` (default 10m), `containerTimeouts`

### Container Instance Types (verified 2026-05-02)
| Type | vCPU | RAM | Disk |
|------|------|-----|------|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

### SAM Wrangler Binding Rules
- Add bindings to **top-level only** in `wrangler.toml`; `sync-wrangler-config.ts` copies static bindings to env sections
- No `[env.*]` sections committed
- Existing pattern: `[[containers]]` + `[[durable_objects.bindings]]` + `[[migrations]]`
- Needs new migration tag (currently at v12)

### Architecture Decision
- Knowledge graph confirms: Containers exploration targets **top-level and project-level** SAM agents, not task agents
- Sandbox SDK path preferred over raw Containers (no need to build HTTP server inside container)
- Agent loop stays in Worker/DO; Sandbox SDK handles I/O

## Implementation Checklist

### Phase A: Setup & Bindings
- [ ] Install `@cloudflare/sandbox` in `apps/api`
- [ ] Create minimal `Dockerfile` for sandbox container (Alpine + git)
- [ ] Add `[[containers]]` binding to top-level `wrangler.toml` with `instance_type = "basic"`
- [ ] Add `[[durable_objects.bindings]]` for Sandbox class
- [ ] Add `[[migrations]]` tag v13 for new Sandbox sqlite class
- [ ] Update Env type in `apps/api/src/env.ts` with `SANDBOX` binding
- [ ] Verify `sync-wrangler-config.ts` copies the containers binding correctly

### Phase B: Admin Test Route
- [ ] Create `apps/api/src/routes/admin-sandbox.ts` with admin-only gate
- [ ] Register route in `apps/api/src/index.ts` at `/api/admin/sandbox/*`
- [ ] Implement `POST /api/admin/sandbox/exec` — run command, return stdout/stderr/exitCode + timing
- [ ] Implement `POST /api/admin/sandbox/git-checkout` — clone a repo, measure time
- [ ] Implement `POST /api/admin/sandbox/files` — read/write files, measure time
- [ ] Implement `GET /api/admin/sandbox/status` — container status/health
- [ ] Implement `POST /api/admin/sandbox/backup` — create/restore backup, measure time
- [ ] Implement `GET /api/admin/sandbox/exec-stream` — SSE streaming exec

### Phase C: Local Testing
- [ ] Write unit/integration tests for admin sandbox routes
- [ ] Verify Miniflare/wrangler dev handles the sandbox binding locally (or document limitation)
- [ ] Test exec, file read/write, git checkout against local Docker

### Phase D: Staging Measurement
- [ ] Deploy to staging via `deploy-staging.yml`
- [ ] Measure cold start time (first request after deploy)
- [ ] Measure warm exec latency (subsequent commands)
- [ ] Measure git clone time for a small repo (e.g., octocat/Hello-World)
- [ ] Measure git clone time for a medium repo
- [ ] Measure streaming exec latency
- [ ] Measure backup/restore cycle time
- [ ] Test sleep/wake behavior (configured sleepAfter)
- [ ] Document all measurements in PR

### Phase E: Cleanup & Documentation
- [ ] Clean up any staging resources created during testing
- [ ] Write recommendation: Sandbox SDK path, raw Containers path, or defer
- [ ] Update CLAUDE.md if new bindings/env vars added
- [ ] Ensure all changes pass lint/typecheck/test/build

## Acceptance Criteria

- [ ] Local Worker prototype covers Sandbox SDK features that work in local dev
- [ ] Staging deploy verifies production-only features OR reports exact platform/credential blocker
- [ ] Admin-only test routes are gated behind `requireSuperadmin()`
- [ ] PR includes measurements, logs, workflow run links, cleanup notes
- [ ] PR includes clear recommendation: Sandbox SDK path, raw Containers path, or defer
- [ ] No production user flows exposed
- [ ] Wrangler binding follows top-level-only rule (no `[env.*]` sections)

## References

- Parent idea: 01KQM8JT6CPHGS16Y91XJF67FS
- Prior research: session 6efb961c-874f-4d6a-8e39-9398a5bf6beb
- Library docs: `/research/agent-harness/03-cloudflare-containers-research.md`
- Library docs: `/research/agent-harness/05-sam-architecture-gaps.md`
- Library docs: `/research/agent-harness/08-recommendation-and-action-plan.md`
- Official docs: https://developers.cloudflare.com/sandbox/
- Sandbox SDK npm: https://www.npmjs.com/package/@cloudflare/sandbox
