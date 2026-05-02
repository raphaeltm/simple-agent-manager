# Cloudflare Sandbox SDK Prototype: Recommendation

**Date:** 2026-05-02
**PR:** #880
**Branch:** `sam/execute-task-using-skill-01kqma`
**Status:** Staging verification BLOCKED (Containers API Forbidden)

## Executive Summary

We prototyped Cloudflare Sandbox SDK (`@cloudflare/sandbox` v0.7.20) integration for SAM's project-level and top-level agents. The prototype covers exec, file I/O, git checkout, streaming exec, and backup/restore behind admin-only routes with a kill switch. **Local build, lint, typecheck, and tests pass. Staging deployment is blocked because Cloudflare Containers is not enabled on the account.**

**Recommendation: Enable Containers on the account and proceed with the Sandbox SDK path.** The SDK provides exactly the capabilities SAM agents need (git, exec, file I/O, persistence) without requiring us to build an HTTP server inside containers. Defer raw Containers only if the SDK proves insufficient after staging measurement.

## What Was Built

### Bindings and Infrastructure
- `@cloudflare/sandbox` installed in `apps/api`
- `[[containers]]` binding with `class_name = "SandboxDO"`, `image = "./Dockerfile.sandbox"`, `instance_type = "basic"` (1/4 vCPU, 1 GiB RAM, 4 GB disk)
- `[[durable_objects.bindings]]` for `SANDBOX` → `SandboxDO`
- `[[migrations]]` tag `v13` with `new_sqlite_classes = ["SandboxDO"]`
- `Dockerfile.sandbox`: Alpine 3.20 + git + openssh-client + curl + jq
- `sync-wrangler-config.ts` updated to propagate `ContainerBinding[]` to env sections
- `Env` type updated with `SANDBOX?: DurableObjectNamespace<Sandbox>`

### Admin Routes (`/api/admin/sandbox/*`)
All routes gated behind `requireSuperadmin()` + `SANDBOX_ENABLED` kill switch (default: `false`).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | Check sandbox config and binding availability |
| `/exec` | POST | Execute command, return stdout/stderr/exitCode + timing |
| `/git-checkout` | POST | Clone repo with shallow depth, return timing + file listing |
| `/files` | POST | Read, write, or check file existence with timing |
| `/backup` | POST | Create or restore backup with timing |
| `/exec-stream` | GET | SSE streaming command execution |

### Configurable Env Vars
| Var | Default | Purpose |
|-----|---------|---------|
| `SANDBOX_ENABLED` | `false` | Kill switch |
| `SANDBOX_EXEC_TIMEOUT_MS` | `30000` | Command execution timeout |
| `SANDBOX_GIT_TIMEOUT_MS` | `120000` | Git clone timeout |
| `SANDBOX_SLEEP_AFTER` | `10m` | Container sleep-after-idle duration |

## What We Learned

### 1. Wrangler Requires `[[containers]]` (Array Format)
Cloudflare specialist review initially recommended `[containers]` (TOML single table). Staging deploy FAILED with: `"containers" field should be an array, but got {...}`. Wrangler 4.85+ explicitly requires the TOML array-of-tables syntax `[[containers]]`. This was reverted to array format in all code paths:
- `wrangler.toml`: `[[containers]]`
- `types.ts`: `ContainerBinding[]` (not single object)
- `sync-wrangler-config.ts`: `containers: ContainerBinding[] | undefined`

### 2. Containers API Requires Account-Level Enablement
After fixing the TOML format, the second staging deploy failed with `ApiError: Forbidden` / `Authentication error` on the Containers API. This is an account-level prerequisite — the CF account (`c4e4aebd980b626f6af43ac6b1edcede`) needs Containers enabled via the Cloudflare dashboard or support.

### 3. Sandbox SDK Exports the DO Class
The `@cloudflare/sandbox` package exports `Sandbox` which extends `DurableObject` internally. Our Worker re-exports it as `export { Sandbox as SandboxDO } from '@cloudflare/sandbox'` so Wrangler can find the class.

### 4. Type Safety Requires Generic Binding
`getSandbox()` expects `DurableObjectNamespace<Sandbox>`, not bare `DurableObjectNamespace`. The `Env` type must use the generic form.

## Staging Measurements (PENDING)

The following measurements are planned once Containers is enabled:

| Metric | Target | Notes |
|--------|--------|-------|
| Cold start (first request after deploy) | < 5s | Container pull + init |
| Warm exec latency (subsequent commands) | < 500ms | Already-running container |
| Shallow git clone (small repo like octocat/Hello-World) | < 3s | depth=1 |
| Medium repo clone | < 30s | Full clone with history |
| File read/write round-trip | < 200ms | Single file operations |
| Streaming exec first-byte latency | < 1s | SSE stream start |
| Backup create (4GB workspace) | < 10s | Snapshot to R2-backed store |
| Backup restore | < 10s | Restore from snapshot |
| Sleep/wake cycle | < 3s | Container resume from sleep |

## Recommendation: Sandbox SDK Path

### Why Sandbox SDK (Not Raw Containers)

| Consideration | Sandbox SDK | Raw Containers |
|---------------|-------------|----------------|
| **Exec** | `sandbox.exec()` / `execStream()` — built-in | Must build HTTP/WS server inside container |
| **File I/O** | `sandbox.readFile()` / `writeFile()` — built-in | Must build file transfer protocol |
| **Git** | `sandbox.gitCheckout()` — built-in | Must install + invoke git manually |
| **Terminal** | `sandbox.terminal()` → WebSocket — built-in | Must build PTY + WebSocket server |
| **Persistence** | `sandbox.createBackup()` / `restoreBackup()` — built-in | Must implement own snapshot mechanism |
| **Lifecycle** | `sleepAfter` auto-management | Must manage container lifecycle manually |
| **Maintenance** | Cloudflare maintains the SDK | We maintain the in-container server |
| **Image size** | Minimal (Alpine + git) | Larger (needs HTTP server, PTY, etc.) |

The Sandbox SDK eliminates the need to build and maintain an HTTP server inside the container. Every capability SAM agents need (exec, file I/O, git, terminal, persistence) is provided by the SDK out of the box.

### Why Not Defer

1. **SAM agents are currently blind** — they can only read code via GitHub API, which is rate-limited (5,000 req/hr authenticated) and slow for large repos.
2. **Project-level agents need file system access** to reason about code changes, run tests, and produce diffs.
3. **Top-level SAM agent needs exec** to run tooling (linters, type checkers, test runners) as part of its reasoning loop.
4. **Containers pricing is competitive** — basic instances (1/4 vCPU, 1 GiB) are included in the Workers paid plan at reasonable rates. Much cheaper than provisioning Hetzner VMs for non-task agent work.

### Rollout Plan

1. **Phase 1 (this PR):** Enable Containers on CF account, verify staging measurements, merge admin prototype.
2. **Phase 2:** Wire `ProjectAgent` DO to use Sandbox SDK for code-aware tool calls (`readFile`, `exec`, `gitCheckout`).
3. **Phase 3:** Wire `SamSession` DO to use Sandbox SDK for cross-project operations (running scripts, comparing repos).
4. **Phase 4:** Add `terminal()` integration to project chat UI for interactive debugging.
5. **Phase 5:** Evaluate promoting to user-facing workspaces (replacing Hetzner VMs for lightweight tasks).

### Risks

| Risk | Mitigation |
|------|------------|
| Containers API still in beta | Kill switch (`SANDBOX_ENABLED`), admin-only routes, no user exposure |
| Cold start latency too high | Measure on staging; `sleepAfter` keeps containers warm between uses |
| 4 GB disk insufficient for large repos | Start with `basic`, upgrade to `standard-1` (8 GB) if needed |
| SDK API changes in breaking ways | Pin to specific version, dynamic import for graceful degradation |
| Cost unpredictable | `max_instances = 3` cap, admin-only initially |

## Blocker Resolution

**Action required:** Enable Cloudflare Containers on account `c4e4aebd980b626f6af43ac6b1edcede`.

Steps:
1. Go to Cloudflare Dashboard → Workers & Pages → Containers (or contact CF support)
2. Enable Containers for the account
3. Re-trigger staging deploy: `gh workflow run deploy-staging.yml --ref sam/execute-task-using-skill-01kqma`
4. Verify sandbox endpoints respond on staging
5. Run latency measurements
6. Update this document with actual numbers
7. Merge PR

## Deploy Evidence

### CI Status (all green except external SonarCloud)
- Lint: PASS
- Type Check: PASS
- Test: PASS
- Build: PASS
- Code Quality Checks: PASS
- Pulumi Infrastructure Tests: PASS
- Validate Deploy Scripts: PASS
- Specialist Review Evidence: PASS
- VM Agent Smoke (mock + worker): PASS

### Staging Deploy Attempts
1. **Run 25252376115** — FAILURE: `"containers" field should be an array` (TOML format fix applied)
2. **Run 25252444695** — FAILURE: `ApiError: Forbidden` (Containers not enabled on account)

### Workflow Links
- CI: All checks green on PR #880
- Deploy staging run 1: `gh run view 25252376115`
- Deploy staging run 2: `gh run view 25252444695`
