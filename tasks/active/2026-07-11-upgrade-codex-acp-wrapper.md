# Upgrade Codex ACP wrapper for Sol-capable Codex runtime

## Problem Statement

SAM's OpenAI Codex agent still installs and launches through the deprecated Zed ACP wrapper package, `@zed-industries/codex-acp`. Raphaël previously hit an ACP `-32603` internal error that wrapped a Codex `400 invalid_request_error` when trying a `gpt-5.6` Codex model. The prior investigation concluded this was a Codex runtime/version mismatch rather than a SAM prompt issue.

OpenAI's newer Codex runtime knows about `gpt-5.6-sol`, but SAM's wrapper path can keep launching an older runtime. We need to move SAM to the maintained replacement wrapper, `@agentclientprotocol/codex-acp`, without changing the production auth architecture.

This is not an AI Gateway feature. Gateway mocks were useful only to prove ACP compatibility. Production Sol access should continue through Codex's native OpenAI/Codex auth and entitlement path.

## Research Findings

- Prior SAM conversation `ca998350-ba3b-4ebe-b3ef-9714184c7761` (`Codex ACP gpt-5.6 support path`) captured the user-visible failure:
  - ACP error code `-32603`
  - ACP message `Internal error`
  - nested Codex status `400`
  - nested Codex error type `invalid_request_error`
  - failure while trying a `gpt-5.6` Codex model
- `@zed-industries/codex-acp@0.16.0` is deprecated on npm and explicitly says it has been replaced by `@agentclientprotocol/codex-acp`.
- `@agentclientprotocol/codex-acp@1.1.2` bundles `@openai/codex@0.144.1`; local inspection found `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` in that runtime.
- A local ACP smoke test with a mocked OpenAI Responses endpoint verified the replacement wrapper can:
  - initialize ACP,
  - authenticate,
  - create a session,
  - expose and select `gpt-5.6-sol`,
  - send a prompt,
  - receive streamed assistant text and usage.
- SAM's existing native Codex auth path must remain intact:
  - `tasks/active/2026-03-03-openai-codex-oauth-token-support.md` documents that Codex OAuth uses `~/.codex/auth.json`; there is no OAuth token env var.
  - `packages/vm-agent/internal/acp/session_host_startup.go` writes Codex startup config and injects `NO_BROWSER=1` / refresh proxy env.
  - `packages/vm-agent/internal/acp/gateway.go` chooses command/install metadata and auth-file vs env-var injection.
- Current old-package references:
  - `packages/shared/src/agents.ts`
  - `packages/vm-agent/internal/acp/gateway.go`
  - `packages/vm-agent/internal/acp/gateway_test.go`
  - specs/task history references, most of which are historical and should not necessarily be rewritten.

## Implementation Checklist

- [x] Update OpenAI Codex agent catalog install metadata in `packages/shared/src/agents.ts` from `@zed-industries/codex-acp` to `@agentclientprotocol/codex-acp`.
- [x] Update VM-agent OpenAI Codex install command strings in `packages/vm-agent/internal/acp/gateway.go` to install `@agentclientprotocol/codex-acp`.
- [x] Preserve the `codex-acp` command name and sandbox override behavior.
- [x] Preserve OAuth auth-file injection for `openai-codex` `oauth-token` credentials.
- [x] Preserve API-key env injection for `openai-codex` `api-key` credentials.
- [x] Update focused Go tests in `packages/vm-agent/internal/acp/gateway_test.go` to assert the new install command for both credential kinds.
- [x] Add or update TypeScript unit coverage for the shared agent catalog install command if existing coverage does not assert it.
- [x] Search for non-historical references to the old package and update only active runtime/test metadata, not archived specs/tasks unless they would mislead active behavior.
- [x] Run targeted local tests for shared agent metadata and VM-agent ACP command metadata.
- [ ] Run broader validation required by `/do`.
- [ ] Deploy the branch to staging.
- [ ] Use Playwright staging auth with `SAM_PLAYWRIGHT_PRIMARY_USER` to start a primary user's project conversation with OpenAI Codex using a standard smaller/default model, then verify the agent responds.
- [ ] Open the PR, wait for CI, merge when green, and monitor production deploy.

## Acceptance Criteria

- Runtime OpenAI Codex installation no longer references `@zed-industries/codex-acp`.
- Runtime OpenAI Codex installation uses `@agentclientprotocol/codex-acp`.
- Existing Codex native OAuth behavior remains auth-file based.
- Existing Codex API-key behavior remains env-var based.
- Existing sandbox/permission behavior is preserved or intentionally adapted with tests.
- Local test coverage proves the package swap for Codex startup metadata.
- Staging verification proves a standard Codex session still starts and responds with the new wrapper.
- PR is merged only after required checks and staging verification pass.

## References

- Library note: `Upgrade SAM's Codex ACP Wrapper For GPT-5.6 Sol`
- Prior SAM conversation: `ca998350-ba3b-4ebe-b3ef-9714184c7761`
- Existing OAuth task: `tasks/active/2026-03-03-openai-codex-oauth-token-support.md`
- Runtime command metadata: `packages/vm-agent/internal/acp/gateway.go`
- Runtime startup config: `packages/vm-agent/internal/acp/session_host_startup.go`
- Shared agent catalog: `packages/shared/src/agents.ts`
- VM-agent tests: `packages/vm-agent/internal/acp/gateway_test.go`
