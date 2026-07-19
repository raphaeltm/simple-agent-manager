# Fix Instant-Container Regression: Partial Clone + Configurable Create-Workspace Timeout

## Problem Statement

All production instant (cf-container) sessions are failing. First observed failure 2026-07-18 20:49 UTC (tasks `01KXVFVC0K0SKTSP0JEYR65ARK`, `01KXVFYV25WNJF1YCE8S1ZR75E`, error `Request timed out after 30000ms`); still failing at 2026-07-19 00:43 UTC (two "Hello?" probes stuck `queued` forever). VM-runtime sessions are unaffected.

### Root Cause (verified in-session)

1. Instant sessions create their workspace via ONE synchronous control-plane HTTP request with a fixed 30s timeout: `launchInstantSession` → `createWorkspaceOnNode` → `nodeAgentRequest` with `DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS = 30_000` (`apps/api/src/services/node-agent.ts:17`, timeout raced at `node-agent.ts:260`).
2. In standalone/container mode the vm-agent handles `POST /workspaces` synchronously: `handleCreateWorkspace` → `handleStandaloneWorkspaceCreate` → `prepareStandaloneWorkspaceRuntime` → `cloneStandaloneRepository` runs a **full** `git clone --branch <branch> <url> <dir>` inside the request (`packages/vm-agent/internal/server/workspaces.go:610`, `standalone_workspace.go:104`). The VM path is different: `handleAsyncWorkspaceCreate` returns 202 and clones in the background with a 15-minute ready budget — which is why VMs are unaffected.
3. The repository pack tripled to **371 MiB** in ~36h: "chore: save agent work" auto-commits on 2026-07-17 (~11:57–14:35) and 2026-07-18 (07:30) repeatedly committed `.codex/` runtime state — 17 copies of an ~10–12 MB SQLite log, WAL files, plugin caches, plus committed `packages/vm-agent/vm-agent` compiled binaries. Blobs >2 MB in history now total **413 MB**. PR #1622 stopped tracking `.codex/` but the blobs remain in history, so every fresh clone still downloads them.
4. Measured on a fast Hetzner VM: full clone = 15.0s wall / **12.3s user CPU** / 373 MB `.git`. The cf-container instance (`standard-1`, fractional vCPU) multiplies that CPU cost 2–4×, pushing the clone past 30s → `Request timed out after 30000ms` → instant session dead.
5. Verified NOT a code regression: staging runs the same code (mega-PR 392e02c7b included) and a live instant session against a small repo launched in 14.8s total (`workspaceCreateDurationMs: 6273`) and produced a valid conversation (agent replied "pong"). The 2026-07-18 production deploys are innocent; the repo content is the variable.

### Failure-shape notes

- 30s-timeout shape: `launch` + health OK in ~5s, then `create_workspace` hits the raced 30s timeout → task `failed`.
- Stuck-`queued` shape: the browser/client disconnects mid-launch; the Worker request dies without running the catch block → task stays `queued`, workspace stays `creating`. Filed separately: `tasks/backlog/2026-07-19-instant-launch-stuck-queued-on-disconnect.md`.

## Fix

Two surgical changes:

### 1. Partial clone for standalone/container workspace prep (vm-agent)

`cloneStandaloneRepository` gains `--filter=blob:none` (blobless partial clone):

- Measured here: 4.8s wall / 2.3s user CPU / 41 MB `.git` for the same repo — and it never downloads historical blobs that are not in the checked-out tree (the 200 MB+ of dead `.codex` blobs are skipped entirely).
- Full history metadata (commits/trees) is retained, so `git log`, merge-base, rebase, branch create, push, and PR flows all behave normally; file-content history (blame/old diffs) lazy-fetches on demand.
- Lazy fetches authenticate via the persistent system credential helper installed by `ConfigureStandaloneGitCredentialHelper` (`standalone_git.go`), so private repos keep working after the temporary clone-time helper is cleaned up.
- Env-configurable per Constitution XI: `STANDALONE_CLONE_FILTER` (vm-agent env), default `blob:none`; setting it to `off`/`none` disables the flag entirely (full clone). Worker-side passthrough `CF_CONTAINER_CLONE_FILTER` → container launch env so self-hosters can override without rebuilding the image.
- VM bootstrap clone (`internal/bootstrap/bootstrap.go:822`) intentionally NOT changed — async path with a 15-min budget, working today, devcontainer flows depend on it; keep the fix tight.

### 2. Env-configurable create-workspace timeout for the cf-container path (API)

- New `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` with `DEFAULT_CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS = 120_000` in `node-agent.ts` (mirrors existing `CF_CONTAINER_WAKE_TIMEOUT_MS = 120_000` used by the wake/restore path, which re-runs the same clone).
- `createWorkspaceOnNode` accepts an optional `requestTimeoutMs`, threaded to `nodeAgentRequest`; `launchInstantSession` passes the configured cf-container create timeout.
- Rationale: rule 43 — a network+CPU-bound operation that can make legitimate slow progress must not be bounded by an undersized fixed interactive deadline. 120s is a ceiling, not the expected duration (expected: <10s after partial clone).
- Other `createWorkspaceOnNode` callers (VM paths: `node-lifecycle.ts`, `workspaces/_helpers.ts`, task-runner `workspace-steps.ts`) keep the 30s default — their create is a fast 202 dispatch ack. Task-runner references cf-container only for cleanup, so `launchInstantSession` is the sole cf-container creation path (plus the DO wake path which already has its own 120s budget).

## Implementation Checklist

- [x] vm-agent: `--filter` injection inlined in `cloneStandaloneRepository` (plus `standaloneCloneWarnings` success-path warning surfacing); filter value from `Config.StandaloneCloneFilter`
- [x] vm-agent: `Config.StandaloneCloneFilter` loaded from `STANDALONE_CLONE_FILTER` (default `blob:none`, `off`/`none`/empty-after-trim disables) in `config.Load`
- [x] API: `CF_CONTAINER_CLONE_FILTER` passthrough into container launch envVars in `durable-objects/vm-agent-container.ts` (only when set)
- [x] API: `getCfContainerCreateWorkspaceTimeoutMs` + `DEFAULT_CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` in `node-agent.ts`; optional `requestTimeoutMs` on `createWorkspaceOnNode`
- [x] API: `launchInstantSession` passes the create-workspace timeout
- [x] Env plumbing: add `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` + `CF_CONTAINER_CLONE_FILTER` to `apps/api/src/env.ts` and `apps/api/.env.example`
- [x] Docs: vm-agent reference (`apps/www/src/content/docs/docs/reference/vm-agent.md`) + configuration reference if it lists CF_CONTAINER_* vars
- [x] Go tests: clone args include `--filter=blob:none` by default (discriminating — fails on pre-fix code); custom filter value honored; `off` disables; config parsing tests
- [x] TS tests: `getCfContainerCreateWorkspaceTimeoutMs` default/env/invalid; `createWorkspaceOnNode` honors `requestTimeoutMs` behaviorally (small timeout → `Request timed out after Xms`, larger → succeeds); instant-session passes the configured timeout to the create-workspace call
- [x] Quality suite green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; `go test ./...` in `packages/vm-agent` (two full passes: initial + post-review-fixes)

### Review Findings Addressed (Phase 5)

- **go-specialist (HIGH)**: partial clone silently falls back to a FULL clone on servers without `uploadpack.allowFilter` (git warns + exits 0), and the success-path clone output was discarded — no production signal for the fallback. Fixed: `standaloneCloneWarnings` extracts bounded `warning:` lines and logs them at Warn on success (`standalone_workspace.go`). Cloudflare **Artifacts** git filter support is unverified — staging Phase 6 exercises an artifacts-backed instant session (Potato project) to observe behavior; GitHub (the incident repo host) is confirmed to support filters. Either way behavior degrades to the pre-fix full clone, never worse.
- **go-specialist (MEDIUM)**: `ResolveStandaloneCloneFilter` doc claimed "blank disables" but `getEnv` maps empty env to the default — doc corrected; the supported disable keywords are `off`/`none`/`false`.
- **test-engineer (HIGH)**: the DO `launch()` `STANDALONE_CLONE_FILTER` passthrough had no test — added `vm-agent-container-launch-env.test.ts` (prototype-borrowing pattern) covering forwarded + omitted cases. This exact spread was transiently deleted by a concurrent working-tree write during review, proving the gap was live, not hypothetical.
- **env-validator (HIGH) / constitution-validator (MEDIUM)**: new env vars weren't in the deploy pipeline optional-var allowlists — wired into `deploy-reusable.yml` + `sync-wrangler-config.ts` with tests.
- **security-auditor (HIGH)** — disposition, in-branch mitigation + tracked remainder:
  - *Cancellation half (the part this PR's 120s budget touches)*: in the instant path a create-workspace timeout is immediately followed by `destroyVmAgentContainer` in `launchInstantSession`'s catch, which kills the container and the in-flight clone — the zombie window is the destroy latency (sub-second), NOT the 120s budget. This containment is now contractual: new regression test `destroys the container when create-workspace times out` (instant-session.test.ts). A general `AbortController` through `fetchNodeAgent` remains follow-up work (tracked).
  - *Quota half (pre-existing)*: no per-user instant quota vs the platform-wide `max_instances = 3`. NOT introduced or materially worsened by this PR — every SUCCESSFUL session already holds a slot for up to 1h (`sleepAfter`), which dominates the failure-path ceiling change (30s→120s). Rushing a naive quota into this hotfix would count this incident's own stranded `creating` rows and could lock the user out; needs the stale-row escape path designed first. Tracked in `tasks/backlog/2026-07-19-instant-session-capacity-controls.md` and surfaced to Raphaël prominently in the PR + completion report for explicit sign-off.
  - *Related hardening shipped in-branch*: task-runner warm-pool/capacity reuse queries now exclude cf-container nodes (`node-steps.ts` + runtime-guard test) — closes the adjacent latent path where a running instant node could be selected for task dispatch and 409.
- **doc-sync-validator (MEDIUM)**: `configuration.md` now lists both new vars; companion task path refs fixed.

## Acceptance Criteria

- [ ] Fresh instant session on staging (fix branch deployed) launches and produces a valid conversation — including against a large-history repository comparable to `raphaeltm/simple-agent-manager` (413 MB of large blobs)
- [ ] Standalone clone command line contains `--filter=blob:none` by default; override/disable paths covered by tests
- [ ] cf-container create-workspace request honors `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` with 120s default; VM callers keep the 30s interactive default
- [ ] No behavior change for VM-runtime provisioning
- [ ] Production: after merge + deploy, a new instant session completes end-to-end (verified live)

## Post-Mortem

- **What broke**: Every production instant (cf-container) session failed at launch; users got dead sessions ("Hello?" never answered).
- **Root cause**: Synchronous full `git clone` inside a fixed 30s interactive request timeout + unbounded repo-history growth (accidentally committed agent runtime state, ~200 MB+). Two safety margins eroded silently until they crossed.
- **Timeline**: Bloat commits 07-17 11:57 → 07-18 07:30; `.codex` tracking stopped (not purged) 07-17 15:14 (#1622); first observed failure 07-18 20:49; reported 07-19 00:47; diagnosed and fixed 07-19.
- **Why not caught**: (1) The 30s ceiling was invisible — no test or alert models clone duration vs. repo size; staging validates against small repos, production runs a 371 MiB repo. (2) `chore: save agent work` auto-commits pushed large binaries straight to main with no size gate. (3) The stuck-`queued` shape hid the error from task records.
- **Class of bug**: Fixed interactive deadline bounding work whose cost scales with unmonitored data growth (rule 43's class, on the instant-session boot path).
- **Process fix (in this PR)**: rule 43 amended with the instant-session clone incident lesson. A repo large-file guard is deferred (with the history purge decision) to `tasks/backlog/2026-07-19-repo-history-bloat-cleanup.md` — it is NOT yet in place.

## References

- `.claude/rules/43-long-running-mcp-tools.md` (deadline vs. progress-watchdog rule)
- `.claude/rules/47-control-loop-io-budget.md` (tiered timeouts: interactive vs background)
- `tasks/backlog/2026-07-19-instant-launch-stuck-queued-on-disconnect.md` (companion bug)
- `tasks/backlog/2026-07-19-repo-history-bloat-cleanup.md` (history purge decision for Raphaël)
- `tasks/backlog/2026-07-19-instant-session-capacity-controls.md` (security-review follow-up: per-user instant quota + request cancellation)
- SAM task `01KXVXG90E6TEY6ADDAHP29HX9` (this incident)
