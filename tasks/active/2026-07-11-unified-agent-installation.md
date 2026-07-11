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

- [ ] Add a schema-validated, pinned structured agent install manifest with no free-form shell fields.
- [ ] Generate and commit the Go runtime install table from that manifest, including a deterministic sync check that rejects manual drift.
- [ ] Remove the dead TypeScript `installCommand` field and update catalog tests/spec references to the structured source.
- [ ] Preserve named Go hooks for vetted custom post-install behavior such as Amp's Python patches.
- [ ] Pin all catalog installer package versions and migrate Amp to `@ampcode/cli`.
- [ ] Add a standalone-only user-writable `SAM_AGENT_HOME` layout for npm and uv tools, with the same bin directory used by install detection and process launch.
- [ ] Keep devcontainer installation root-based, while generalizing npm partial-install cleanup to the selected package rather than one vendor scope.
- [ ] Generate the cf-container pre-bake install plan from the same manifest and bake the supported catalog set into `Dockerfile.vm-agent-container`.
- [ ] Expose a deterministic cf-container supported-agent manifest/contract so image capability cannot silently diverge from the catalog.
- [ ] Persist agent-selection failures to the durable session error state and add a user-visible system chat message, without leaking sensitive installer details.
- [ ] Add focused Go and TypeScript tests covering manifest validation/sync, rootless standalone installs, devcontainer behavior, pre-bake coverage, cleanup paths, and failure persistence.
- [ ] Update relevant public architecture/runtime documentation and reconcile the older binary-install hardening task.

## Acceptance Criteria

- [ ] Every catalog agent has a pinned, structured install specification shared by generation outputs; CI fails on catalog/runtime/image drift.
- [ ] Standalone installs never require writes to root-owned global npm or uv paths, and installed binaries are discoverable by both the fast path and launched process.
- [ ] Devcontainer installs retain the documented root/npm-bootstrap behavior and do not receive a conflicting global npm prefix.
- [ ] The cf-container image pre-bakes every supported catalog agent that fits the measured image budget, or explicitly records any measured exclusion with a tested rootless fallback.
- [ ] Amp installs the maintained `@ampcode/cli` package at a pinned version and its ACP bridge post-install behavior remains covered.
- [ ] An install/selection failure produces durable failed/error session state plus a visible system message while preserving existing BootLog/error reporting.
- [ ] Local Go/TypeScript tests and the repository quality suite pass.
- [ ] The PR documents that staging was intentionally skipped and remains unmerged per explicit instruction.

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
