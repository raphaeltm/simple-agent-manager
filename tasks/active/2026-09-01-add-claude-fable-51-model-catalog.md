# Add Claude Fable 5.1 to Model Catalogs

## Problem

Anthropic launched Claude Fable 5.1 on 2026-09-01. SAM still exposes Claude Fable 5
as the top Claude Code frontier choice, so users cannot discover Fable 5.1 in agent
profile model selectors, and `providerMode: 'sam'` profiles typed manually would not
pass the platform AI proxy allowlist.

## Research Findings

- Official Claude Platform docs list the Claude API ID as `claude-fable-5-1`.
- Manual testing confirmed Claude Code rejects `claude-fable-5-1` on version
  2.1.205 and reports that version 2.1.251 or newer is required.
- Anthropic pricing docs list Claude Fable 5.1 at $10 / MTok input and $50 / MTok
  output, matching Fable 5 base token pricing. Cost metadata is therefore
  `0.01` input and `0.05` output per 1K tokens.
- The model comparison lists Fable 5.1 with a 1M-token context window and 128K-token
  max output.
- The model deprecations page shows `claude-fable-5-1` as Active with retirement
  not sooner than 2027-09-01. Existing retired Anthropic IDs in SAM remain retired;
  no newly retired active-catalog ID was found during this check.
- `.claude/rules/52-model-catalog-lifecycle.md` requires updating both canonical
  lists: `packages/shared/src/model-catalog.ts` for agent profile dropdowns and
  `packages/shared/src/constants/ai-services.ts` for platform AI proxy metadata.
- Native 1M Claude 5-family models use base IDs in SAM, not Claude Code-only `[1m]`
  selector variants.
- The normal VM on-demand install path in `packages/vm-agent/internal/acp/gateway.go`
  must install and validate the underlying Claude Code CLI, not just the ACP adapter,
  otherwise an existing container with `claude-agent-acp` present can keep using an
  old Fable-5.1-incompatible `claude` binary.
- `apps/api/Dockerfile.vm-agent-container` and `apps/api/Dockerfile.sandbox`
  pre-bake runtime images and must pin a Fable-5.1-capable Claude Code CLI version.

## Implementation Checklist

- [x] Add `claude-fable-5-1` to the Claude Code "Claude 5 (Frontier)" dropdown group.
- [x] Add `claude-fable-5-1` to `PLATFORM_AI_MODELS` with Anthropic premium pricing,
      1M context, and AI Gateway unified model ID derivation.
- [x] Update focused shared tests for dropdown presence, 1M labeling, no `[1m]`
      variant, known-model detection, and platform metadata.
- [x] Refresh recent-change docs that still pointed at Opus 5 as the newest frontier
      option.
- [x] Pin baked runtime image Claude Code CLI installs to `2.1.258`.
- [x] Update the VM-agent install path to install the Claude Code CLI companion and
      re-run installation when the existing CLI is below the `2.1.251` floor.
- [x] Add focused runtime contract tests for the Claude Code CLI pin and version
      guard.
- [x] Run focused shared tests and relevant validation.
- [ ] Complete specialist review, PR creation, and CI follow-up.

## Acceptance Criteria

- Users can manually set `claude-fable-5-1` in a Claude Code agent profile.
- `claude-fable-5-1` appears in Claude Code model selectors.
- SAM platform AI proxy allowlisting and metadata accept `claude-fable-5-1`.
- New instant-runtime images and VM on-demand installs include a Claude Code CLI
  version new enough to run `claude-fable-5-1`.
- Focused tests fail if the dropdown entry or platform metadata is removed.

## References

- Anthropic models overview: https://platform.claude.com/docs/en/models/overview
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic model deprecations: https://platform.claude.com/docs/en/about-claude/model-deprecations
- Anthropic Claude Code model config: https://code.claude.com/docs/en/model-config

## Validation

- `pnpm --filter @simple-agent-manager/shared test -- model-catalog ai-model-registry` — passed.
- `pnpm --filter @simple-agent-manager/shared typecheck && pnpm --filter @simple-agent-manager/shared lint` — passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/cf-container-runtime-contract.test.ts` — passed.
- `pnpm --filter @simple-agent-manager/api typecheck && pnpm --filter @simple-agent-manager/api lint` — passed.
- `cd packages/vm-agent && go test ./internal/acp -run 'TestGetAgentCommandInfo|TestAgentInstallScriptCleansBrokenGitHubCLIRepoBeforeNpmBootstrap' -count=1` — passed.
- `cd packages/vm-agent && go test ./internal/acp -count=1` — passed.
- `pnpm quality:agent-install-manifest` — passed.
- `pnpm quality:dependency-governance` — passed.
- `pnpm format:check` — passed.
- `pnpm typecheck` — passed; www template checker reported the existing baseline
  `4 baseline error(s), 0 warning(s), 16 hint(s)`.
- `pnpm build` — passed.

## Review Findings

- `task-completion-validator`: Implementation checks passed for manual model code,
  dropdown catalog, platform proxy metadata, and Claude Code runtime minimum. The
  initial review verdict was procedural FAIL because the PR had not been created yet.
- `cloudflare-specialist`: WARN, no blocking issue. Staging validation is required
  before merge because Cloudflare runtime container images changed. Existing already
  running Claude sessions are not hot-upgraded until restart/switch/wake/new session.
- `test-engineer` / `constitution-validator`: WARN for duplicated Claude Code minimum
  version literal inside the shell validation command. Fixed by deriving the command
  from `claudeCodeMinVersion` and adding a regression test.
