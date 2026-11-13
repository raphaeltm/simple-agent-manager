# Add Claude Fable 5.2 and a Claude Code harness that can run it

## Problem

Raphaël asked for Fable 5.2. A Claude Code session started with it (parent task
`01M724HG7CN685EY26PRTR3P0R`, session `bedc647f-d0ee-4982-bc0b-5e8e09a26586`) failed on every
turn with `API Error: 400 Claude Code 2.1.280 does not support this model; version 2.1.290 or
newer is required.` The model is also missing from SAM's catalogs.

## Research Findings

- Anthropic models overview (checked 2026-11-10): Claude API ID `claude-fable-5-2`, $8 input /
  $40 output per MTok, 1M context, 128K max output. Deprecations page: active, retirement not
  sooner than 2027-11-09. No new retirements since the last catalog refresh, so nothing to prune.
- The `2.1.280` in the error is the binary bundled in `@anthropic-ai/claude-agent-sdk` 0.3.280
  inside `@agentclientprotocol/claude-agent-acp` 0.81.2, not the separately installed companion
  CLI (2.1.281). SAM never sets `CLAUDE_CODE_EXECUTABLE`, so the adapter runs its SDK's binary.
- Anthropic's Claude Code docs (`code.claude.com/docs/en/model-config`) and help center article
  15424964 say "Fable 5.2 requires Claude Code v2.1.321 or later". The API's rejection only names
  2.1.290, which is a hard floor, not the supported minimum. CodeRabbit caught this after the PR
  first pinned 0.88.0 (SDK 0.3.293). The only adapter bundling SDK >= 0.3.321 is 0.102.0 (SDK
  0.3.321, `@agentclientprotocol/sdk` 2.5.0). Release notes 0.82.0-0.88.0 reviewed, and the
  0.81.2/0.88.0/0.102.0 `dist/` diffed. Compared against 0.81.2 source: `errorKind`/`authRequired` auth classification,
  `_meta.steering` + `idleBehavior=promptRequired`, `usage_update` `_claude/rateLimit`, and
  `_claude/sdkMessage` raw-message contracts are unchanged.
- Behaviour change: unsupported MCP elicitation modes answer `cancel` instead of `decline`
  (0.102.0). The answer goes to Claude Code's MCP client; SAM never sees it.
- Behaviour change: from 0.85 the AskUserQuestion "Other" fields carry
  `_meta._askUserQuestionCustomAnswer` only for AIR clients. SAM is not AIR. Both validators
  (`packages/shared/src/acp-form.ts`, `packages/vm-agent/internal/acp/acp_form_validation.go`)
  accept a field without `_meta`, no UI code reads the marker, and the adapter still reads
  `question_<n>_custom` answers. The pinned fixture must be regenerated from the pinned builder.
- Pin locations (rule `packages/vm-agent/.claude/rules/06-vm-agent-patterns.md`): install
  manifest, `gateway.go`, `Dockerfile.vm-agent-container`, `Dockerfile.sandbox`, e2e mocks,
  pinned-adapter verification scripts, version/steering tests.

## Implementation Checklist

- [x] Add `claude-fable-5-2` to `CLAUDE_MODELS` and `PLATFORM_AI_MODELS` with published pricing
- [x] Shared tests: dropdown presence, 1M list, no `[1m]` variant, `isKnownModel`, platform metadata
- [x] Adapter 0.81.2 -> 0.102.0, companion CLI 2.1.281 -> 2.1.321, `claudeCodeMinVersion` -> 2.1.321
      across manifest, Go installer, Instant image, sandbox image, mocks
- [x] Regenerate the Claude AskUserQuestion forms fixture from the 0.102.0 builder; update the URL
      verifier for `cancel` and the new session fields
- [x] Update version-check and steering tests and adapter-version comments
- [x] Docs: recent product changes, integrations page, changelog skill
- [x] Local go-specialist review of 0.88.0: PASS (no blocking findings)
- [x] CodeRabbit: Fable 5.2 needs 2.1.321 (repinned to 0.102.0); docs entry moved to the 4-10 Nov cycle
- [ ] PR, CI, merge, production deploy, production verification with a real Fable 5.2 prompt

## Acceptance Criteria

- [ ] A Claude Code session on `claude-fable-5-2` answers a prompt in production
- [x] `claude-fable-5-2` is selectable for Claude Code and accepted by the SAM AI proxy allowlist
- [x] A reused runtime with the 0.81.2 adapter fails the installed check and reinstalls

## Local Validation

On the final 0.102.0 / 2.1.321 pins:

- `pnpm --filter @simple-agent-manager/shared test -- model-catalog ai-model-registry acp-form`: 79 passed
- `go test ./internal/acp` (Go 1.26.10): pass, including shell stale adapter/CLI checks
- `TestShippedClaudeAdapterSteersRunningTurn` with the real 0.102.0 adapter (Initialize, NewSession,
  Prompt, mid-turn steer, end_turn), against both the bundled 2.1.321 binary and a 2.1.322 CLI: pass
- `verify-pinned-acp-form-fixtures.mjs` and `verify-pinned-acp-url-paths.mjs` against installed
  0.102.0 + codex-acp 2.1.1: pass
- `pnpm quality:agent-install-manifest`, API `cf-container-runtime-contract` test: pass
- Guided sign-in driver (`claude-setup-token.mjs`) with real CLI 2.1.321 reaches `waiting_for_user`
  with a validated authorize URL. Token capture needs a real account and was not exercised.

## Staging

Skipped at Raphaël's explicit request ("Skip staging if possible"). Verification happens in
production after deploy.
