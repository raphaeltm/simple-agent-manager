# Unified Agent Installation Across Runtimes

**Created:** 2026-07-11  
**Source:** SAM idea `01KX8TMYBBC103W1DR1VG61H33` and originating session `4088a0e4-7623-43cf-bc7a-5d868d5d5c00`  
**Constraint:** Open an unmerged PR. Do not deploy or mutate staging and do not merge to production.

## Problem

Cloudflare-container instant sessions run the vm-agent as a non-root user, but on-demand agent installers target root-owned global npm and uv paths. Only Claude is currently pre-baked, so Codex and other catalog agents can fail before producing a chat response. Selection failures reach BootLog and the control-plane error reporter but are not durably visible on the agent session or in chat. The TypeScript catalog and Go runtime also maintain divergent install commands.

## Research Findings

- `packages/vm-agent/internal/acp/gateway.go` is the live install source. Its devcontainer path deliberately runs as root and includes a Node/npm bootstrap; the standalone path runs as the vm-agent user.
- A global `NPM_CONFIG_PREFIX` would conflict with the nvm-based devcontainer Node feature. Rootless install configuration must therefore be scoped to standalone/cf-container execution only.
- `packages/shared/src/agents.ts` exposes `installCommand`, but runtime code does not consume it. Tests are its only executable consumer.
- `apps/api/Dockerfile.vm-agent-container` pre-bakes Claude packages only and then switches to `USER node`.
- `startLocalProcess` resolves binaries using the vm-agent process environment; install detection must use the same effective PATH.
- npm stale-directory cleanup is hardcoded to the `@zed-industries` scope and does not cover the other catalog packages.
- Amp still uses the legacy unpinned `@sourcegraph/amp` package even though the maintained package is `@ampcode/cli`.
- The existing binary-install hardening task (`tasks/backlog/2026-03-13-binary-install-security-hardening.md`) already calls for eliminating TS/Go drift and securing install inputs; this task must reconcile rather than duplicate that work.
- Selection failure currently sets in-memory/WebSocket error status and calls `reportAgentError`, but does not update the durable ACP/agent-session record or insert a system chat message.
- The originating design review rejected node boot-time probes: devcontainer capability is per-session, while cf-container capability is an image-build constant.

## Implementation Checklist

- [x] Add a schema-validated, pinned structured agent install manifest with no free-form shell fields.
- [x] Keep the committed Go runtime install table synchronized with the manifest through a deterministic CI check that rejects manual drift.
- [x] Remove the dead TypeScript `installCommand` field and update catalog tests/spec references to the structured source.
- [x] Preserve named Go hooks for vetted custom post-install behavior such as Amp's Python patches.
- [x] Pin all catalog installer package versions and migrate Amp to `@ampcode/cli`.
- [x] Add a standalone-only user-writable `SAM_AGENT_HOME` layout for npm and uv tools, with the same bin directory used by install detection and process launch.
- [x] Keep devcontainer installation root-based, while generalizing npm partial-install cleanup to the selected package rather than one vendor scope.
- [x] Synchronize the cf-container pre-bake plan with the same manifest in CI and bake the supported catalog set into `Dockerfile.vm-agent-container`.
- [x] Expose a deterministic cf-container supported-agent manifest/contract so image capability cannot silently diverge from the catalog.
- [x] Persist agent-selection failures to the durable session error state and add a user-visible system chat message, without leaking sensitive installer details.
- [x] Add focused Go and TypeScript tests covering manifest validation/sync, rootless standalone installs, devcontainer behavior, pre-bake coverage, cleanup paths, and failure persistence.
- [x] Reconcile the older binary-install hardening task; no public behavior documentation changes are required for this internal runtime fix.

## Acceptance Criteria

- [x] Every catalog agent has a pinned, structured install specification shared by generation outputs; CI fails on catalog/runtime/image drift.
- [x] Standalone installs never require writes to root-owned global npm or uv paths, and installed binaries are discoverable by both the fast path and launched process.
- [x] Devcontainer installs retain the documented root/npm-bootstrap behavior and do not receive a conflicting global npm prefix.
- [x] The cf-container image pre-bakes every supported catalog agent that fits the measured image budget, or explicitly records any measured exclusion with a tested rootless fallback.
- [x] Amp installs the maintained `@ampcode/cli` package at a pinned version and its ACP bridge post-install behavior remains covered.
- [x] An install/selection failure produces durable failed/error session state plus a visible system message while preserving existing BootLog/error reporting.
- [x] Local Go/TypeScript tests and the repository quality suite pass.
- [x] The original no-staging/no-merge constraint was documented; the later 2026-07-15 user instruction explicitly superseded it for staging verification and merge.

## Verification Evidence

- Local Node 22 cf-container image built successfully with all six agent stacks and the Amp hook.
- Image size: 735,871,006 bytes (0.736 GB), below the 8 GB standard-1 disk budget.
- Non-root runtime user resolved all catalog binaries and completed a real rootless global npm fallback install under `SAM_AGENT_HOME`.
- Initial staging was intentionally skipped by the original instruction; 2026-07-15 continuation later deployed the PR branch to staging for verification.

## References

- SAM idea `01KX8TMYBBC103W1DR1VG61H33`
- Originating failure session `caf03acc-91b3-4b85-880c-c8743f68bb52`
- `packages/vm-agent/internal/acp/gateway.go`
- `packages/vm-agent/internal/acp/process.go`
- `packages/vm-agent/internal/acp/session_host_selection.go`
- `packages/shared/src/agents.ts`
- `apps/api/Dockerfile.vm-agent-container`
- `tasks/backlog/2026-03-13-binary-install-security-hardening.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/36-cli-quality.md` (only if CLI code becomes affected)

## Continuation: ACP Startup Failure Reconciliation (2026-07-15)

User explicitly authorized continuing this previously draft/no-staging PR through staging verification and merge. After merging current `main`, the branch now also fixes the raw cf-container instant-session failure mode where vm-agent `/start` returned 202 before ACP `NewSession` actually succeeded.

Additional checklist:

- [x] Merge current `main` into PR branch and preserve the pinned install manifest plus baked vm-agent container artifact path.
- [x] Make vm-agent report `activity=error` with a redacted `statusError` when agent selection or ACP startup fails before the initial prompt.
- [x] Make the Worker activity callback reconcile error activity into failed ACP lifecycle state, D1 `agent_sessions.status='error'`, failed chat session state, and ended cf-container active work.
- [x] Preserve terminal-state idempotency so duplicate late error reports do not re-fail completed/interrupted sessions.
- [x] Add focused API and Go tests for the callback and redacted error activity payload.
- [x] Deploy to staging and verify a real instant cf-container session starts successfully.
- [ ] Get PR checks green, mark ready if needed, merge, and monitor production deployment.

Validation so far:

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/agent-activity-callback.test.ts tests/unit/acp-session-activity-schema.test.ts tests/unit/vm-agent-cross-boundary-contract.test.ts` passed: 41 tests.
- `pnpm --filter @simple-agent-manager/api lint` passed with existing warnings only.
- `pnpm --filter @simple-agent-manager/api typecheck` passed after building `@simple-agent-manager/shared`, `@simple-agent-manager/providers`, and `@simple-agent-manager/cloud-init`.
- `pnpm exec tsx scripts/quality/check-agent-install-manifest.ts` passed.
- `/tmp/go/bin/go test ./internal/acp` passed with Go 1.25.0.
- `pnpm test` passed across the monorepo after updating the cf-container runtime contract test.
- `pnpm build` passed.
- `pnpm lint` passed with existing warnings only.
- `pnpm typecheck` passed.
- `cd packages/vm-agent && /tmp/go/bin/go test ./...` passed.
- Staging deploy workflow run `29440536587` completed successfully, including `deploy / Deploy to Cloudflare` and `smoke-tests`.
- Existing staging token-login Playwright smoke passed against `api.sammy.party`.
- Temporary staging instant-session smoke passed against `api.sammy.party`: project `01KTKXZ4ZZAT6MJFXRW1ZTQ7RB`, profile `01KX2N3REWHCAT1QDG927BR52M`, session `3f8871f3-a7e2-4a26-8645-6ec2ff427deb`, workspace `01KXKHH4F86Z6B7TRD659ZAWV1`, node `01KXKHH4AM9Z81NBHVN6SEQZ0Q`, ACP/session `01KXKHHCQZ7HM1M0JS2505HV4G`; startup returned `runtime.cf-container` in 10.9s and produced 12 messages including assistant text `pr1565 instant smoke ok`.
