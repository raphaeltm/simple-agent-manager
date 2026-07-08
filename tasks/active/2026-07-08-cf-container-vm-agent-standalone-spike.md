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
- [ ] Run local quality gates, specialist reviews, staging deployment, live staging verification, and append results to idea `01KWY8E8W1J4F3AC3QAETT2RAT`.
- [ ] Open a draft PR on `sam/execute-task-using-skill-2cs1ky`, add `needs-human-review`, and stop without merging.

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
- [ ] Re-run local quality gates, specialist reviews, and staging verification on the productionized path.

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
- Historical spike push blocker is resolved for the continuation branch; current commits have pushed to `sam/execute-task-using-skill-2cs1ky`.
- Remaining follow-up gates: specialist reviews, staging deployment, live cf-container measurement, append results to idea `01KWY8E8W1J4F3AC3QAETT2RAT`, update draft PR #1544, and stop without merging.

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
