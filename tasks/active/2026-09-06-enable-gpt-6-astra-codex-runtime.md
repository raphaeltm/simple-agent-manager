# Enable GPT-6 Astra in Codex runtimes

## Problem Statement

A SAM agent profile configured with `model: gpt-6-astra` started successfully but
the persisted Codex rollout identified the effective model as `gpt-5.6-sol`.
SAM exported `OPENAI_MODEL=gpt-6-astra`, yet the maintained ACP adapter launched
its own older Codex dependency, whose bundled model catalog did not contain Astra.
The adapter rejected SAM's later ACP model-selection request and SAM treated that
failure as non-fatal, leaving the default Sol model active.

Raphael asked for the necessary runtime upgrades in a green pull request. Staging
verification is explicitly waived for this task; local validation and CI are the
delivery gates. The PR must remain open and unmerged unless separately requested.

## Preflight

### Classification

- `infra-change`: VM/devcontainer and cf-container agent installation/runtime behavior.
- `external-api-change`: compatibility with the published OpenAI Codex and Codex ACP packages.
- `cross-component-change`: manifest, VM-agent installer/startup, and cf-container images must agree.
- `docs-sync-change`: the retained runtime contract and process rules need correction.

### External references and verified assumptions

- Official OpenAI model guidance confirms `gpt-6-astra` is the exact model ID and
  supports `xhigh`: https://developers.openai.com/api/docs/guides/latest-model
- Published npm metadata checked on 2026-09-06:
  `@agentclientprotocol/codex-acp@1.10.0` is latest and depends on
  `@openai/codex@^0.153.3`; `@openai/codex@0.153.4` is latest.
- A clean isolated install of `codex-acp@1.10.0` resolved Codex 0.153.4. Its
  bundled catalog includes `gpt-6-astra`, and the adapter still supports
  `CODEX_PATH`, `CODEX_CONFIG`, `INITIAL_AGENT_MODE`, and ACP model selection.
- Existing profile storage and `ModelSelect` accept custom model IDs, so enabling
  this already-configured profile does not require expanding SAM's static model or
  platform-proxy pricing catalogs.

### Impact and data-flow trace

1. A profile model reaches VM-agent startup in
   `packages/vm-agent/internal/acp/session_host_startup.go:applyModelAndExtraEnv`.
2. `packages/vm-agent/internal/acp/gateway.go:getAgentCommandInfo` installs and
   validates the Codex ACP adapter plus companion Codex CLI.
3. `packages/vm-agent/internal/acp/session_host_startup.go:writeCodexStartupConfig`
   supplies the wrapper launch controls, including the explicit Codex executable.
4. `packages/vm-agent/internal/acp/session_host_handshake.go:startNewACPSession`
   receives model configuration options and applies the requested model through
   `SessionHost.applySessionSettings`.
5. `@agentclientprotocol/codex-acp` forwards the selected model to the Codex
   app-server used for subsequent prompts.

The install path runs at every agent selection but skips installation when its
binary/version validation passes. The cf-container image bakes the same pins once
per image build. No request-path query or persistent-data cost changes are involved.

### Constitution and risk check

- Principle XI/no hardcoded drift: the canonical manifest remains synchronized
  with every runtime install surface through the existing quality gate.
- Principle XIII/fail fast: an explicitly requested Codex model must be applied or
  session startup must return an actionable error; silently using another model is
  not an acceptable success state.
- Supply-chain scope stays pinned to exact published versions.
- Existing live processes cannot change model binaries in place; the version
  validation upgrades stale installed binaries on the next agent start.

## Research Findings

- Regression-introducing commit: `49489364d` (2026-09-04) upgraded the standalone
  companion Codex CLI to 0.153.2 while pinning `codex-acp` 1.8.0.
- `codex-acp` 1.8.0 declares `@openai/codex@^0.152.0`. Under semver rules for
  zero-major packages, 0.153.2 does **not** satisfy that range, so npm retained a
  nested 0.152.x Codex under the adapter.
- The adapter resolves `@openai/codex/bin/codex.js` relative to itself unless
  `CODEX_PATH` is set. Therefore the separately installed 0.153.2 CLI was not the
  runtime used by ACP.
- The 0.152.x catalog contains Sol but not Astra; 0.153.4 contains both.
- `OPENAI_MODEL` is exported by SAM but is not the Codex model-selection contract.
  SAM also calls ACP `SetSessionConfigOption`, but
  `SessionHost.applySessionModelConfigOption` currently logs and swallows rejection.
- Existing tests assert package strings and environment injection, but none prove
  that the adapter uses the pinned companion or that a rejected requested Codex
  model fails session startup.

## Implementation Checklist

- [x] Upgrade `@agentclientprotocol/codex-acp` to 1.10.0 and `@openai/codex` to
      0.153.4 in the canonical manifest and all synchronized runtime images/installers.
- [x] Add exact Codex adapter/CLI version validation so stale workspace installs
      are refreshed on the next agent start.
- [x] Set `CODEX_PATH=codex` in both VM/devcontainer and standalone/cf-container
      startup paths so the adapter executes the explicitly pinned companion CLI.
- [x] Make failure to apply an explicitly requested Codex model fail session
      establishment instead of silently retaining the adapter default.
- [x] Add discriminating Go tests for current/stale versions, exact launch env on
      both runtime paths, successful Astra selection, and rejected selection.
- [x] Update the agent startup contract rule so wrapper upgrades verify the actual
      launched companion and model/capability, not a separately installed binary.
- [x] Update synchronized runtime documentation and the post-mortem below.
- [x] Run focused package/quality tests, the full repository quality suite, and
      required specialist reviews.
- [ ] Archive this task record, open the PR, and keep CI/CodeRabbit green.
- [x] Skip staging per the user's explicit instruction and document that exception
      in the PR.

## Acceptance Criteria

- A clean or stale SAM runtime installs `codex-acp` 1.10.0 and Codex 0.153.4,
  and the ACP adapter launches that pinned Codex companion.
- A profile configured with `gpt-6-astra` causes SAM to send that exact value
  through the real ACP session configuration request.
- If the adapter rejects the configured Codex model, session startup fails with
  model-specific diagnostic context instead of continuing on a default model.
- Manifest synchronization, Go tests, lint, typecheck, tests, build, CI, local
  specialist review, and CodeRabbit review are green.
- The PR remains open and unmerged; staging is documented as a user-approved exception.

## Post-Mortem

### What broke

SAM displayed and persisted an Astra-configured profile while actually running
GPT-5.6 Sol. The session looked healthy, so the mismatch was detectable only by
inspecting Codex's persisted rollout context and model-specific base instructions.

### Root cause

Commit `49489364d` treated the separately installed Codex 0.153.2 companion as the
adapter runtime and incorrectly stated it satisfied `codex-acp`'s `^0.152.0`
dependency. Npm instead installed a nested 0.152.x copy, which the adapter resolved
by default. The configured Astra model was unavailable there, and SAM swallowed the
ACP selection error as non-fatal.

### Timeline

- 2026-09-04: commit `49489364d` upgraded the Codex stack to adapter 1.8.0 plus
  standalone CLI 0.153.2.
- 2026-09-06: an Astra-configured SAM conversation self-identified as GPT-5; runtime
  inspection confirmed its rollout model was `gpt-5.6-sol`.
- 2026-09-06: a clean adapter 1.10.0 install was verified to resolve Codex 0.153.4
  and advertise Astra.

### Why it was not caught

The previous upgrade inspected each published package and synchronized exact pin
strings, but it did not inspect the clean npm dependency tree or the executable path
the adapter actually launched. It also reasoned incorrectly about zero-major caret
semver. Tests proved the standalone companion existed and the model value was
exported, not that the wrapper used that companion or accepted the model.

### Class of bug

Wrapper/companion dependency drift hidden by testing adjacent installed artifacts
instead of the executable and capability reached through the production launch path.

### Process fix

Extend `.claude/rules/23-cross-boundary-contract-tests.md` to require clean-resolution
and executable-path verification for agent adapters with companion runtimes, plus a
test that reaches any model/capability through the adapter's production selection path.

## References

- `packages/shared/src/agent-install-manifest.json`
- `packages/vm-agent/internal/acp/gateway.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- `packages/vm-agent/internal/acp/session_host_handshake.go`
- `packages/vm-agent/internal/acp/session_host.go`
- `apps/api/Dockerfile.vm-agent-container`
- `apps/api/Dockerfile.sandbox`
- `tasks/archive/2026-09-04-update-codex-claude-opencode-clients.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
