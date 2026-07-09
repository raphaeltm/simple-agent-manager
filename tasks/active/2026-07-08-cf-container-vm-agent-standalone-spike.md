# SPIKE: Cloudflare Container vm-agent standalone mode

## Problem

Step 2 of the "Instant workspaces on Cloudflare Containers" feasibility work must answer one end-to-end question: can a standalone `vm-agent` boot inside the Cloudflare Sandbox container, register a virtual node, send heartbeats to the control plane, and complete one chat session with the ACP WebSocket proxied through the container Durable Object.

This is a feasibility spike, not a production feature. The PR must be opened as a draft, labeled `needs-human-review`, and left unmerged for Raphaël to review. All behavior must remain behind the existing `SANDBOX_ENABLED` kill switch, default off.

## Research Findings

- SAM idea `01KWY8E8W1J4F3AC3QAETT2RAT` selects Option A: port the vm-agent contract into a CF container with a local workspace filesystem and a `ProcessLauncher` abstraction. Do not re-litigate Option A.
- Step 1 passed on 2026-07-08 using staging: `cloudflare/sandbox:0.12.1`, `SANDBOX_ENABLED=true`, `SANDBOX_EXEC_TIMEOUT_MS`, `standard-1`, Claude Code startup around 132 MiB marginal memory, container cold start around 3.2s, egress and git clone working.
- `packages/vm-agent/main.go` currently branches only between deployment and workspace modes. Standalone mode must skip host provisioning, cloud-init bootstrap, Docker/devcontainer/TLS/DNS/port-scanner behavior, serve plain HTTP, and rely on env-provided bootstrap/config.
- `packages/vm-agent/internal/acp/process.go` is the ACP process-spawn seam. It currently builds `docker exec`, writes secret env files, and performs in-container process kill. The spike needs a `ProcessLauncher` interface with existing docker behavior preserved and a local launcher using direct process spawning plus negative-PGID kill.
- `packages/vm-agent/internal/pty/session.go` has the PTY Docker reference. It needs to keep existing docker exec behavior and support local PTY sessions for standalone mode.
- `apps/api/src/routes/admin-sandbox.ts`, `apps/api/Dockerfile.sandbox`, and the `SANDBOX` binding in `apps/api/wrangler.toml` provide the container substrate and kill switch. Main still has `cloudflare/sandbox:0.9.2` and `instance_type = "basic"`; Step 2 must re-apply the Step 1 bump to `0.12.1` and `standard-1`.
- Existing node/workspace heartbeat machinery expects `workspaces.node_id`; the spike must not make it nullable for this path. Add a `runtime: 'cf-container'` discriminator for virtual nodes and route only that runtime through the container DO.
- Rule constraints: callback JWT routes must stay out of session-auth routers, cross-boundary calls need contract tests, cross-boundary features need vertical-slice/capability tests, vm-agent staging verification requires fresh node/agent refresh handling, and live staging verification must measure the WebSocket path in a browser or equivalent real WebSocket client.

## Implementation Checklist

- [x] Re-apply Sandbox image/config prior art: `cloudflare/sandbox:0.12.1`, `standard-1`, spike env handling for `SANDBOX_EXEC_TIMEOUT_MS`, with `SANDBOX_ENABLED` remaining default off.
- [x] Add `vm-agent` standalone mode config and `runStandaloneMode` in `packages/vm-agent/main.go`.
- [x] Introduce a `ProcessLauncher` abstraction in ACP process spawning with `dockerExec` preserving current behavior and `local` spawning directly with process-group cleanup and secret-safe env handling.
- [x] Route PTY sessions through the same launcher choice or equivalent local/docker abstraction without regressing Docker PTY behavior.
- [x] Wire standalone workspace runtime: local filesystem workspace, no provision/bootstrap/devcontainer/docker/TLS/DNS/port-scanner, plain HTTP to the container DO, and env-provided control-plane/bootstrap/callback config.
- [x] Add virtual node registration for a single-workspace `runtime: 'cf-container'` node behind `SANDBOX_ENABLED`; reuse existing node heartbeat/status fields and keep `workspaces.node_id` populated.
- [x] Add routing from `ws-{id}.BASE_DOMAIN` through Worker to the `SANDBOX` container DO for `cf-container` workspaces only.
- [x] Preserve callback JWT authentication for all VM-agent callbacks and add/adjust contract tests for Worker ↔ vm-agent/container DO boundaries.
- [x] Add a vertical-slice/capability test covering cf-container workspace creation/routing/heartbeat state with realistic mocked D1/DO boundaries.
- [x] Add measurement support/reporting for cold start, node-register time, heartbeat arrival, WebSocket-proxy round-trip latency, and one chat session transcript/evidence.
- [x] Run local quality gates, specialist reviews, staging deployment, live staging verification, and append results to idea `01KWY8E8W1J4F3AC3QAETT2RAT`.
- [x] Open a draft PR on `sam/execute-task-using-skill-2cs1ky`, add `needs-human-review`, and stop without merging.

## Productionization Continuation Checklist

The spike has answered the feasibility question through the admin-only launcher. Continue on the same draft PR by wiring the validated runtime into the normal chat/profile flow while keeping the PR unmerged for human review.

- [x] Add a user-visible runtime discriminator to agent profiles and skills (`vm` / `cf-container`) with migration, schema, API, shared type, validation, and mapper coverage.
- [x] Add a runtime resolver that preserves existing VM behavior when `SANDBOX_ENABLED` is off, honors explicit profile runtime, and defaults zero-config/platform-credential users to `cf-container` while leaving BYO-cloud users on `vm`.
- [x] Extract reusable Sandbox helpers and an instant-session launch service from the validated admin spike sequence.
- [x] Remove the admin-only `/api/admin/sandbox/cf-vm-agent/start` launcher after the user-facing start path exists, keeping diagnostic sandbox routes.
- [x] Add a user-facing chat/session start endpoint that launches a `cf-container` session through the extracted service and preserves task/session auth boundaries.
- [x] Add unit or vertical-slice tests covering resolver decisions, instant-session launch sequencing, and chat start endpoint behavior across realistic mocked boundaries.
- [x] Add web UI controls for runtime selection where users edit profiles/skills and a chat start affordance for starting a cf-container session.
- [x] Run Playwright visual audit for changed web surfaces at mobile and desktop sizes.
- [x] Re-run local quality gates, specialist reviews, and staging verification on the productionized path.

## Screenshot Follow-up: Container Checkout and Tool Routing

The 2026-07-09 screenshot follow-up found two regressions in the productionized path:

- `mcp__sam-mcp__get_workspace_info` returned a Cloudflare `403` / `error code: 1014` because MCP/file proxy helpers still fetched public `*.vm.BASE_DOMAIN` node hostnames directly. CF container nodes do not have publicly routable VM hostnames; Worker-to-agent calls must use the Sandbox container DO routing path.
- The agent shell showed `/workspaces/workspace` empty because instant sessions booted the standalone VM agent with a generic `/workspace` workdir and the standalone `create workspace` path marked the workspace `running` without materializing the repository checkout.

Follow-up implementation checklist:

- [x] Make instant-session CF container workdirs repository-specific (`/workspaces/<repo>`) and pass the same value as `WORKSPACE_DIR` and `CONTAINER_WORK_DIR`.
- [x] Add `SANDBOX_WORKSPACE_BASE_DIR` so the Sandbox checkout base path has an operator override while defaulting to `/workspaces`.
- [x] Set the sandbox image default workdir to `/workspaces` so shell startup and VM-agent config agree.
- [x] Clone/materialize the repository in standalone `handleCreateWorkspace` before marking the workspace `running` or sending the ready callback.
- [x] Keep standalone git credentials out of clone URLs by using a temporary git credential helper, then sanitize the repository origin URL after clone.
- [x] Reject unsafe standalone clone targets before any destructive cleanup or git command.
- [x] Teach VM-agent git/file/raw/download/upload and completion git push helpers to execute directly in standalone mode instead of requiring Docker.
- [x] Reuse `fetchNodeAgent` for MCP workspace tools, file proxy routes, library upload/download helpers, local-forward proxying, and node log streaming so `runtime='cf-container'` nodes route through Sandbox.
- [x] Add/extend focused tests for repo-specific instant-session workdirs, Sandbox-aware proxy surfaces, standalone clone-before-ready behavior, standalone local workspace info, token-redacted clone specs, and standalone workspace exec args.

## Validation Notes

- Local gates passed on 2026-07-08:
  - `pnpm test` (19 turbo tasks, API 391 files / 5,858 tests)
  - `pnpm --filter @simple-agent-manager/api typecheck`
  - `pnpm --filter @simple-agent-manager/api lint` (existing warning backlog only)
  - `pnpm build`
  - `cd packages/vm-agent && go test ./...`
- Productionization continuation gates passed on 2026-07-08:
  - `pnpm --filter @simple-agent-manager/web exec vitest run tests/unit/pages/project-chat.test.tsx tests/unit/components/agent-profiles.test.tsx`
  - `pnpm --filter @simple-agent-manager/web typecheck`
  - `pnpm --filter @simple-agent-manager/web exec eslint src/lib/api/sessions.ts src/lib/api/index.ts src/components/agent-profiles/ProfileFormDialog.tsx src/pages/project-chat/useProjectChatState.ts src/pages/project-chat/ChatInput.tsx tests/unit/pages/project-chat.test.tsx tests/unit/components/agent-profiles.test.tsx`
  - `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/project-chat-composer-audit.spec.ts`
- Productionized path broad gates passed on 2026-07-08 after aligning stale API contract tests:
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/cf-container-runtime-contract.test.ts tests/unit/services/agent-profiles.test.ts`
  - `pnpm test` (19 turbo tasks, API 395 files / 5,869 tests, Web 216 files / 2,646 tests)
  - `pnpm typecheck`
  - `pnpm lint` (existing warning backlog only)
  - `pnpm build`
- Specialist review notes on 2026-07-08:
  - Cloudflare specialist: no local blockers found. Sandbox remains behind `SANDBOX_ENABLED`, uses `cloudflare/sandbox:0.12.1` / `standard-1`, and D1/runtime changes are additive. Staging Cloudflare verification remains required.
  - Security auditor: no high/critical findings. The user-facing start route keeps auth, approval, project capability, and repository access gates; callback/MCP tokens are generated through existing services; grep/review found no new secret logging.
  - Constitution validator: no Principle XI blocker found. New internal URLs derive from `BASE_DOMAIN`; sandbox and heartbeat values remain env-configurable; fixed literals are protocol/runtime flags.
  - Test engineer: local coverage is adequate for resolver decisions, instant-session sequencing, start-route behavior, source-level boundary contracts, web runtime submit branching, and Playwright UI audit. Live staging measurement remains the remaining acceptance gap.
  - UI/UX specialist: selected the inline wizard runtime step with compact profile runtime badges over a hidden profile-only setting or a separate composer-level runtime toggle. Playwright screenshots cover iPhone SE, iPhone 14, and desktop runtime wizard states with no layout failures.
  - Task-completion validator: WARN, not archive-ready. Local productionized implementation and quality gates are covered, but staging deployment, live cf-container measurement, idea append, and draft PR update remain open.
- Staging productionized-path verification passed on 2026-07-08:
  - GitHub Actions staging deploy workflow `28980055879` passed; deploy job completed in 7m38s with health check and smoke-tests completed in 2m1s.
  - Live staging used `https://api.sammy.party` and `https://app.sammy.party` with the staging smoke token.
  - Temporary explicit `cf-container` profile was created on project `hono` (`01KTKXZ4ZZAT6MJFXRW1ZTQ7RB`) and deleted after launch.
  - `POST /api/projects/01KTKXZ4ZZAT6MJFXRW1ZTQ7RB/sessions/start` returned `201` in 16,674 ms with `{ runtime: 'cf-container', reason: 'explicit-cf-container' }`.
  - Session `291d3716-4a74-4158-b744-c825649f326d`, workspace `01KX1Y90YX0450Q081DP9MH752`, virtual node `01KX1Y90SCV0X04N58V7W65KPR`, ACP session `01KX1Y9A9P2884SAX3TX15DHTX`.
  - Returned timings: setup 10,831 ms; install 7,879 ms; agent-ready/heartbeat wait 174 ms; workspace create 642 ms; ACP session create 642 ms; ACP session start 288 ms.
  - Account-map verification showed node `status='running'`, `healthStatus='healthy'`, `vmLocation='cf-container'`, `cloudProvider='cloudflare'`, `vmSize='standard-1'`, heartbeat `2026-07-08T22:42:25.962Z`, and workspace `nodeId` populated.
  - Browser verification loaded the live staging chat URL with no unexpected console errors and rendered assistant marker `SAM_CF_CONTAINER_SMOKE_OK`; screenshot evidence at `apps/web/.codex/tmp/staging-evidence/cf-container-live-final-291d3716-4a74-4158-b744-c825649f326d.png`.
  - Browser WebSockets observed notification, ProjectData session, and workspace ACP sockets; direct browser open to `wss://ws-01kx1y90yx0450q081dp9mh752.sammy.party/agent/ws?...` succeeded in 2,191 ms.
  - Transcript persisted 4 messages (`user`, `user`, `assistant`, `assistant`); assistant chunks combined to `SAM_CF_CONTAINER_SMOKE_OK`.
  - `pnpm quality:observability-noise` completed with no significant noise detected; D1 check skipped because `OBSERVABILITY_DB_ID` was unset and Workers telemetry skipped with API 403.
  - Results appended to idea `01KWY8E8W1J4F3AC3QAETT2RAT`.
  - Final task-completion validation: PASS for the requested draft-PR handoff. Do not archive/merge automatically; human review remains required.
- Historical spike push blocker is resolved for the continuation branch; current commits have pushed to `sam/execute-task-using-skill-2cs1ky`.
- Draft PR #1544 remains open, draft, labeled `needs-human-review`, and unmerged.
- Screenshot follow-up local validation on 2026-07-09:
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/services/instant-session.test.ts tests/unit/cf-container-runtime-contract.test.ts tests/unit/routes/mcp-library-tools.test.ts` passed (3 files / 45 tests).
  - `pnpm --filter @simple-agent-manager/api typecheck` passed.
  - `pnpm --filter @simple-agent-manager/api exec eslint src/env.ts src/services/instant-session.ts src/routes/mcp/workspace-tools.ts src/services/node-agent.ts src/routes/mcp/library-tools.ts src/routes/projects/files.ts src/routes/workspaces/local-forward.ts src/routes/nodes.ts tests/unit/services/instant-session.test.ts tests/unit/cf-container-runtime-contract.test.ts tests/unit/routes/mcp-library-tools.test.ts` passed with the existing warning-only non-null assertions in `mcp-library-tools.test.ts`.
  - `PATH=/tmp/go1.25.0/go/bin:$PATH /tmp/go1.25.0/go/bin/go test ./internal/server -run 'Test(CreateWorkspaceStandaloneClonesBeforeRunning|CreateWorkspaceStandaloneRejectsUnsafeWorkDir|ResolveContainerForWorkspaceStandaloneUsesLocalWorkDir|StandaloneCloneSpecStripsEmbeddedCredentials|FileDownloadWorkspaceExecArgs_DashSeparator|McpWorkspaceInfo_StandaloneUsesLocalWorkspace)'` passed.
  - `git diff --check` passed.
  - `PATH=/tmp/go1.25.0/go/bin:$PATH /tmp/go1.25.0/go/bin/go test ./...` in `packages/vm-agent` is still blocked in this container by missing Docker/Compose, with failures from Docker-dependent PTY/bootstrap/server tests such as `exec: "docker": executable file not found in $PATH` and host publish tests reporting no compose command.
- Screenshot follow-up specialist scan on 2026-07-09:
  - Cloudflare/routing: no local blocker. Worker-to-agent MCP, file, library, local-forward, and node log stream calls now reuse `fetchNodeAgent`, which routes `runtime='cf-container'` nodes through the Sandbox binding and leaves VM nodes on the existing direct hostname path.
  - Security: no high/critical finding in the touched surface. Standalone clone credentials are fetched with existing callback-token auth, passed to git via a temporary credential helper/env, redacted from clone failure output, and stripped from the stored origin URL. Unsafe clone targets are rejected before cleanup or git execution.
  - Constitution Principle XI: no blocker. Internal URLs derive from `BASE_DOMAIN`; request timeouts use existing env-configurable helpers; the new Sandbox checkout base is configurable via `SANDBOX_WORKSPACE_BASE_DIR` with `/workspaces` as the default.
  - Go review: no local blocker. Standalone execution uses direct `exec.CommandContext` with argv arrays rather than shell interpolation; Docker behavior remains behind the non-standalone branch; focused tests cover local exec, clone ordering, and unsafe workdir rejection.
  - Test coverage: focused API and Go tests cover the screenshot regressions locally. Full staging verification is still required before treating the live productionized path as fully revalidated.

## Acceptance Criteria

- With `SANDBOX_ENABLED` unset/false, there is zero behavior change to existing VM workspace provisioning, Docker ACP spawning, PTY, heartbeat, and routing paths.
- With `SANDBOX_ENABLED=true` on staging, a standalone vm-agent starts inside a CF Sandbox container and registers a `runtime: 'cf-container'` virtual node.
- The control plane receives heartbeat(s) for that virtual node and associates the cf-container workspace with a non-null `node_id`.
- A chat session completes through the existing ACP contract, with the agent WebSocket proxied Worker → container DO → standalone vm-agent.
- The measurement report includes cold start, node-register time, heartbeat arrival time, WebSocket proxy round-trip latency through the container DO, and one chat session transcript/evidence.
- Full `/do` gates pass: build, lint/typecheck/tests, specialist review, staging deploy, and live verification. If WebSocket latency cannot be measured on staging, request human input and do not merge.
- PR is draft, labeled `needs-human-review`, and not merged.

## References

- SAM idea `01KWY8E8W1J4F3AC3QAETT2RAT`
- `packages/vm-agent/main.go`
- `packages/vm-agent/internal/acp/process.go`
- `packages/vm-agent/internal/pty/session.go`
- `apps/api/src/routes/admin-sandbox.ts`
- `apps/api/Dockerfile.sandbox`
- `apps/api/wrangler.toml`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/35-vertical-slice-testing.md`
