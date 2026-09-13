# Update Codex, Claude Code, and OpenCode clients to latest versions

## Problem Statement

SAM's agent runtime pins the Codex, Claude Code, and OpenCode client stacks and they
have drifted behind upstream:

| Package | Pinned | Latest (2026-09-04) |
| --- | --- | --- |
| `@agentclientprotocol/claude-agent-acp` | 0.58.1 | 0.73.0 |
| `@anthropic-ai/claude-code` (companion) | 2.1.258 | 2.1.260 |
| `@agentclientprotocol/codex-acp` | 1.1.2 | 1.8.0 |
| `@openai/codex` (companion) | 0.144.6 | 0.153.2 |
| `opencode-ai` | 1.17.18 | 1.18.27 |

Raphaël asked for a PR that gets these three clients fully up to date, green, and
shipped to production. The ACP wrapper packages are part of each client stack (they are
what SAM actually launches), so "fully up to date" includes them. Gemini, Vibe, and Amp
are out of scope.

## Research Findings

### Pin locations (source of truth + synchronized copies)

- `packages/shared/src/agent-install-manifest.json` — canonical manifest.
- `packages/vm-agent/internal/acp/gateway.go` — Go installer constants/commands:
  `claudeACPInstallPackage` (l.25), `claudeCodeInstallPackage` (l.27),
  `codexACPInstallCommand` (l.945), opencode `installCmd` (l.1010).
- `apps/api/Dockerfile.vm-agent-container` — cf-container baked `npm install -g` line (l.18).
- `packages/vm-agent/internal/acp/gateway_test.go` — asserts exact install commands
  (l.59, 69, 281, 334, 361, 374).
- `scripts/e2e/workspace-mock/mock-claude.sh` — mock `claude --version` echoes 2.1.258.
- CI sync gate: `pnpm quality:agent-install-manifest`
  (`scripts/quality/check-agent-install-manifest.ts`) verifies manifest ⇄ gateway.go ⇄
  Dockerfile agreement; `apps/api/tests/unit/cf-container-runtime-contract.test.ts`
  derives Dockerfile pin assertions from the manifest (no hardcoded versions).

### Compatibility verification (done against the published packages)

- **codex-acp 1.8.0** (inspected published tarball): still starts the ACP server with no
  CLI arg parsing beyond `login`/`cli` subcommands, so the "does not parse Codex CLI -c
  arguments" behavior note remains true; still reads `CODEX_CONFIG` JSON at startup;
  still honors `INITIAL_AGENT_MODE` with the `agent-full-access` mode mapping to
  `danger-full-access` sandbox + `never` approvals — the exact channels
  `session_host_startup.go` uses (`codexACPManagedConfigEnv`,
  `codexACPManagedAgentModeEnv`). Depends on `@openai/codex@^0.152.0`, satisfied by
  0.153.2.
- **claude-agent-acp 0.73.0** (inspected published tarball): the
  `_meta.claudeCode.emitRawSDKMessages` filter contract (`shouldEmitRawMessage`) is
  byte-identical to 0.58.1, and `_claude/sdkMessage` extension notifications are still
  emitted — this is what `session_host_harness_work.go` consumes for
  `background_tasks_changed` / task lifecycle idleness signals. `engines.node >= 22`
  unchanged (cf-container image is `node:22`; devcontainers get node 22 via
  `DefaultAdditionalFeatures`). Bundles `@anthropic-ai/claude-agent-sdk` 0.3.257
  (was 0.3.205). CLI resolution unchanged: `CLAUDE_CODE_EXECUTABLE` env or the SDK's
  bundled platform binary.
- **@openai/codex 0.153.2**: the config.toml keys SAM writes (`sandbox_mode`,
  `approval_policy`, `model_reasoning_effort`, `model_provider`,
  `[model_providers.*]` with `base_url`/`env_key`/`wire_api`, `[mcp_servers.*]` with
  `url` + `bearer_token_env_var`) are stable across 0.144→0.153.
- **opencode-ai 1.18.27** (installed and executed): `opencode acp` subcommand present;
  `OPENCODE_CONFIG_CONTENT` env still loaded ("loaded custom config from
  OPENCODE_CONFIG_CONTENT" path present in the binary). SAM's launch path
  (`opencode acp` + `OPENCODE_CONFIG_CONTENT`) is unaffected.
- **@anthropic-ai/claude-code 2.1.260**: patch-level bump over 2.1.258; satisfies
  `claudeCodeMinVersion = 2.1.251` (Fable 5.1 floor, unchanged).
- Stale comments to update alongside the bump: `gateway.go` l.971 and
  `session_host_startup.go` l.478 name `codex-acp@1.1.2` explicitly; the behavior was
  re-verified against 1.8.0 so the comments should reference the new pin.
- Knowledge note (post-ship): project knowledge records that codex-acp 1.1.2 lacks the
  `_session/steering` extension; 1.8.0 is 1.7-era+ so steering may now be advertised.
  SAM does not consume it (capability-gated), but the knowledge entry should be updated
  after ship.

### Rollout characteristics

- VM sessions install agents at session start inside the devcontainer
  (`installAgentBinary`); presence check is `command -v <bin>` plus, for claude-code, a
  `claude --version >= 2.1.251` validation. Existing live containers keep their current
  binaries until restart/new session — same as every previous bump (see
  `tasks/active/2026-09-01-add-claude-fable-51-model-catalog.md` review notes).
- cf-container (Instant) sessions get the new versions from the image baked at deploy
  time (`Dockerfile.vm-agent-container`).
- Rule 27: staging verification of vm-agent changes requires deleting existing staging
  nodes first so a fresh node/workspace performs the new installs.

## Implementation Checklist

- [x] Bump all five pins in `packages/shared/src/agent-install-manifest.json`.
- [x] Bump `claudeACPInstallPackage`, `claudeCodeInstallPackage`,
      `codexACPInstallCommand`, and the opencode `installCmd` in
      `packages/vm-agent/internal/acp/gateway.go`.
- [x] Update the `codex-acp 1.1.2` behavior comments in `gateway.go` and
      `session_host_startup.go` to cite the new version (behavior re-verified).
- [x] Bump the `npm install -g` line in `apps/api/Dockerfile.vm-agent-container`.
- [x] Update expected install commands in
      `packages/vm-agent/internal/acp/gateway_test.go`.
- [x] Update `scripts/e2e/workspace-mock/mock-claude.sh` version echo to 2.1.260.
- [x] Discovered during implementation: `apps/api/Dockerfile.sandbox` (guided
      credential-setup / admin sandbox image) had drifted pins —
      `@anthropic-ai/claude-code@2.1.258` and `@openai/codex@0.142.5` — plus an
      unpinned install of the deprecated `@zed-industries/claude-agent-acp` that no
      sandbox surface execs (scripts spawn `claude` / `codex` directly). Bumped both
      CLIs to the manifest companions and removed the dead adapter install; added
      contract-test assertions pinning sandbox codex alignment and banning the Zed
      adapter's return (`cf-container-runtime-contract.test.ts`).
- [x] Run `pnpm quality:agent-install-manifest` and the
      `cf-container-runtime-contract` test; run `go test ./internal/acp/...` in
      `packages/vm-agent` (all green; full `go test ./...` runs in Phase 4/CI).
- [x] Full quality suite: lint 13/13 (0 errors), typecheck 19/19, test green (one
      `packages/ui` Textarea timeout under parallel load — untouched package,
      reran solo: 104/104), build 9/9. Full `go test ./...` all 23 packages ok.
- [x] Specialist review round: task-completion-validator PASS (2 LOW addressed),
      go-specialist PASS, cloudflare-specialist ADDRESSED (stale Node-20 comment
      fixed), test-engineer ADDRESSED (test literals now reference package consts;
      sync-gate pin matching made boundary-aware and proven discriminating against
      a `1.18.270` false-positive; sandbox coverage pointer added).
- [x] Add a CLAUDE.md "Recent Changes" entry (doc sync).
- [ ] Staging (rule 27): delete existing staging nodes, deploy branch, start a fresh
      agent session for each updated client that staging credentials allow, verify
      install + ACP handshake + agent response; clean up staging nodes/workspaces
      afterward (Hetzner capacity: staging runs zero VMs at rest).
- [ ] PR through CI, CodeRabbit label loop, merge, monitor production deploy.
- [ ] Post-ship: update the SAM project knowledge entry "SAM event delivery
      compatibility" (codex-acp pinned at 1.1.2 lacks `_session/steering`) to
      reflect the 1.8.0 pin — steering may now be advertised; SAM remains
      capability-gated and does not consume it yet.

## Acceptance Criteria

- All five packages pinned at the latest published versions in every synchronized
  location; `pnpm quality:agent-install-manifest` passes.
- Go tests, shared/api unit tests, lint, typecheck, and build are green.
- A fresh staging session on the new versions completes agent install and ACP
  initialize for the updated clients (with live prompt evidence where staging
  credentials permit).
- No behavior-channel regressions: Codex sessions still receive
  `CODEX_CONFIG`/`INITIAL_AGENT_MODE`, Claude harness-lifecycle raw messages still
  arrive, OpenCode still launches via `opencode acp` with `OPENCODE_CONFIG_CONTENT`.
- Merged to main and production deploy succeeded.

## References

- `.claude/rules/27-vm-agent-staging-refresh.md` — fresh-node staging requirement
- `.claude/rules/54-vm-agent-rollout-compatibility.md` — rollout compatibility
- `.claude/rules/13-staging-verification.md`, `.claude/rules/30-never-ship-broken-features.md`
- `tasks/active/2026-09-01-add-claude-fable-51-model-catalog.md` — previous client bump
- `scripts/quality/check-agent-install-manifest.ts` — sync gate
