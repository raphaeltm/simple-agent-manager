# Fix GPT-6.1 Sol ACP Startup Compatibility

## Problem

Two production tasks using the shared Sol profile failed before agent work because SAM selected `gpt-6.1-sol` only after `session/new`. The deployed `codex-acp` session did not advertise that newly released model in its default model selector, so `session/set_config_option` rejected the exact profile choice with JSON-RPC `-32602 Invalid params`.

The fix must preserve the user's Sol profile choice. It must not silently downgrade the profile or run a different model.

## Research findings

- Production tasks `01M3SGEF9XHDY61ZJXDV784DCJ` and `01M3SGFABN677MVFFCQ47FCPAF` both failed on node `01M3RBQNPZS29SA21HBT4V7KVT` before a prompt. Their agent-session error is `cannot apply requested Codex model "gpt-6.1-sol": ... -32602 Invalid params`.
- The production node reports VM-agent release `e9820d9f9f6beec1bfa99c654d97f41921aaa4e7`. Current synchronized runtime pins are `@agentclientprotocol/codex-acp@1.13.1` and `@openai/codex@0.156.1` for VM installation and the Instant container image.
- A local executable ACP probe of that exact adapter/CLI pair shows the default `session/new` model config option advertises `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, older 5.6 variants, and `gpt-5.5`, but not `gpt-6.1-sol`.
- Upgrading to the currently published `codex-acp@2.0.1` plus Codex `0.159.2` does not fix the default selector: the same executable probe still omits `gpt-6.1-sol`. A wrapper major-version bump is therefore unrelated risk, not the remedy.
- The current VM agent injects `OPENAI_MODEL`, but the adapter's supported startup channel is `CODEX_CONFIG`. SAM's managed `CODEX_CONFIG` currently contains only sandbox and approval settings.
- An executable probe of the exact deployed pair with `CODEX_CONFIG.model = "gpt-6.1-sol"` succeeds: `session/new` reports `currentValue: gpt-6.1-sol`, includes it in the model options, and accepts the existing exact `session/set_config_option` call. This distinguishes provider/catalog availability from ACP session-selection initialization.
- The existing fail-closed post-handshake selection must remain. Pre-seeding the requested model makes the adapter initialize the exact choice; the subsequent call still verifies that exact selection rather than allowing fallback.
- The model belongs in process-scoped `CODEX_CONFIG`, not persistent shared `config.toml`, so one profile selection cannot leak into a later session in the same workspace.

## Checklist

- [x] Generate SAM's managed Codex `CODEX_CONFIG` from the requested profile model with JSON-safe encoding while preserving sandbox and approval controls.
- [x] Keep the post-handshake exact model selection and fatal rejection behavior intact.
- [x] Cover VM/devcontainer and standalone/Instant startup paths with regression tests that prove `gpt-6.1-sol` is present before ACP `session/new`.
- [x] Cover empty settings and special-character encoding so stale or malformed environment values cannot leak into managed configuration.
- [x] Run focused Go tests, the full VM-agent suite, install-manifest synchronization, and repository quality gates.
- [x] Complete Go, test, constitution, and task-completion reviews and address all blocking findings.
- [x] Coordinate staging ownership, deploy the exact candidate, verify real `gpt-6.1-sol` sessions reach the provider on fresh VM and Instant runtimes, record the provider rejection, and clean all temporary resources.
- [x] Open reviewed draft PR #2205 with exact pins, runtime/config-option evidence, staging evidence, rollback notes, and limitations; send it to ACP coordinator task `01M3SG06CFJYF7F6HVJXHTFTN1` before merge.

## Acceptance criteria

- The shared Sol profile remains `gpt-6.1-sol` throughout the fix and verification.
- VM and Instant startup receive a JSON-safe, process-scoped `CODEX_CONFIG` containing the requested Codex model before ACP initialization.
- The exact deployed adapter/CLI pair initializes `gpt-6.1-sol` as the current ACP session model and the existing post-handshake exact-selection check succeeds.
- Unsupported or rejected exact selections still fail closed; SAM never silently runs a fallback model.
- Historical staging VM/Instant startup and cleanup evidence is retained. Per 2026-10-04 user waiver, successful integrated completion is verified by the user in production after shipping.
- Ship after local review and CI under Raphaël’s explicit 2026-10-04 merge authorization.

## References

- `packages/vm-agent/internal/acp/session_host_startup.go`
- `packages/vm-agent/internal/acp/session_host_settings.go`
- `packages/vm-agent/internal/acp/session_host_model_settings_test.go`
- `packages/vm-agent/.claude/rules/06-vm-agent-patterns.md`
- `packages/vm-agent/.claude/rules/27-vm-agent-staging-refresh.md`
- `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`
- `tasks/archive/2026-09-24-refresh-model-harnesses.md`

## Implementation evidence

- `buildCodexACPManagedConfigEnv` now JSON-encodes the requested profile model with SAM's managed sandbox and approval settings before the ACP process starts. The environment remains process-scoped; persistent `config.toml` model state is unchanged.
- Existing `applySessionModelConfigOption` remains unchanged and fatal for rejected Codex selections, so the runtime cannot silently fall back.
- Standalone/Instant and devcontainer startup tests now assert the exact `gpt-6.1-sol` managed environment. Focused ACP tests pass with Go 1.26.6.
- `go test ./...`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm quality:agent-install-manifest` pass. The repository-wide `pnpm test` completed 11,080 tests successfully and reported five unrelated API failures. Isolated reruns passed three affected files; the remaining `nodes-max-nodes-quota.test.ts` timeout reproduces unchanged on `main`, establishing a baseline failure rather than a VM-agent regression.
- Specialist reviews all passed with no findings: task completion (research/checklist/acceptance coverage), Go (ordering, propagation, restart, error and lifecycle behavior), test engineering (discriminating pre-session/exact-selection/runtime-path coverage), and constitution compliance (no hardcoded runtime model or operational knobs).
- Coordinated staging deploy `36751091670` passed for exact head `413d47047`, publishing VM-agent release `76031eeff27ee1169d23c25b00b9b3d0c2261c56` and a refreshed Instant image. Fresh VM and Instant sessions both reached `agent.ready` and selected `gpt-6.1-sol` without the former ACP `-32602 Invalid params`; VM logs explicitly record `ACP: session model config option set` with the exact model.
- A successful live prompt remains blocked by credential/API availability rather than ACP selection. Both runtimes reached the provider and received HTTP 400: `The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.` Staging has active OpenAI OAuth credentials and no enabled OpenAI platform agent API key. The profile was not downgraded or globally mutated.
- Live Chromium regression checks passed on dashboard, project, and settings with no console errors during the VM run. All temporary profiles, sessions, workspaces, and nodes were removed; final node inventory is empty. The branch deploy restored the checked-in ACP-interaction default to false after the preceding activation candidate.

## Exact staging boundary evidence

- Deploy run `36751091670` succeeded for code head `413d470470306a4bf515c720f24e7699416b00ee` and published VM-agent release `76031eeff27ee1169d23c25b00b9b3d0c2261c56`. The current PR head differs only by task/PR evidence commits.
- VM session `afda43f4-0d1d-4d84-aa33-8abb33eeffda` ran on node `01M3SQ9V9Y2Q5JN0DDZN51KMBG` with temporary profile `01M3SQ9H2GV96JCZ8Z2EGW9XSG`.
  - At `2026-09-30T18:00:35.106821275Z`, the VM agent logged `ACP: setting session model config option` with `model=gpt-6.1-sol` and `configId=model`.
  - At `2026-09-30T18:00:35.11453384Z`, it logged `ACP: session model config option set` with the same exact values, then emitted `agent.ready`.
  - The prompt subsequently received HTTP 400 `invalid_request_error`: `The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.` No successful completion occurred.
- Instant session `3c2caea1-e137-4287-9243-a8a12bb902d2` ran on Instant node `01M3SQQ3GRCJJDXH4B5BB9P6R0` with temporary profile `01M3SQQ0JPFZHF1G7N54SHG0AN`, reported the same release, reached `agent.ready`, and received the same exact provider HTTP 400. No successful completion occurred.
- Cleanup is complete: VM session stop returned 200 with `workspaceDeleted=true`; VM node and profile deletion returned 200; the final staging node inventory was empty. The Instant workspace/node/profile were also removed; its initial stop raced container deletion and returned 500, then the stop retry returned 200. No compatibility-test resources remain.
- Read-only production credential metadata shows the Sol profile remains `gpt-6.1-sol` at medium effort and resolves through an active user-scoped OpenAI Codex `oauth-token` represented by an `auth-json` attachment. No project-scoped or platform OpenAI Codex API-key credential is configured. Production is therefore expected to reach the same ChatGPT-account rejection; API-key entitlement for this model remains unproven. No production prompt, secret retrieval, profile mutation, or credential mutation was performed.
- Acceptance boundary: ACP startup and exact session selection are proven on VM and Instant. GPT-6.1 provider completion is not proven, so this evidence does not justify new Sol 6.1 task dispatches by itself.

## 2026-10-04 shipping authorization

Raphaël confirms standalone Sol 6.1 works with his account and explicitly requests finishing and shipping this integration: “Let's get #2 done and shipped. I'm okay with skipping staging so I can test here.” This supersedes the previous draft/merge hold and successful staging completion requirement. Historical staging results above remain accurate for September 30; they do not establish current account eligibility. The shared Sol profile remains unchanged. Production completion will be tested by the user after deployment.

- Existing PR CI passed lint, typecheck, test, build and VM-agent test/integration/E2E.
- Current-main merge-tree check is clean.
- CodeRabbit was already requested and the required wait completed; rate-limited with no review. No new production code has been added in this continuation.
- Fresh local ACP suite passed with Go 1.26.6 (29.012s). Independent continuation review passed Go correctness, task completeness under user waiver, model fail-closed behavior, constitution, and current-main compatibility.
