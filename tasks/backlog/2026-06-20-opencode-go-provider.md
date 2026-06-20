# Add OpenCode Go Provider for GLM 5.2

## Problem

SAM currently exposes OpenCode Zen as the guided/default OpenCode provider. The newest OpenCode models the user wants, specifically GLM 5.2, are exposed through OpenCode's Go provider instead of Zen. Users need a first-class way to select OpenCode Go, have SAM inject the correct OpenCode API key, and have the VM runtime install an OpenCode CLI version that actually knows about `opencode-go/glm-5.2`.

The user explicitly requested this be implemented with `/do` and explicitly requested skipping the staging deployment step.

## Research Findings

- The local code and docs call the existing provider `OpenCode Zen`; the user wrote "Xen", which appears to be a name mismatch rather than a separate provider.
- Official OpenCode docs list Go as a separate OpenCode provider family and show GLM 5.2 under Go.
- `models.dev/providers/opencode-go` identifies the provider ID as `opencode-go`, the model format as `opencode-go/<model>`, the env var as `OPENCODE_API_KEY`, and the API endpoint as `https://opencode.ai/zen/go/v1`.
- OpenCode docs confirm model values use `provider_id/model_id`, so GLM 5.2 should be stored as `opencode-go/glm-5.2`.
- The upstream OpenCode repo contains `opencode-go` provider support and GLM 5.2 transform coverage.
- SAM currently pins OpenCode runtime installation to `opencode-ai@1.4.3`.
- A local smoke test against `opencode-ai@1.4.3` shows `opencode models opencode-go` does not include `opencode-go/glm-5.2`.
- A local smoke test against `opencode-ai@1.17.8` shows `opencode models opencode-go` includes `opencode-go/glm-5.2`.
- `packages/shared/src/types/agent-settings.ts` is the shared source of truth for OpenCode provider IDs, metadata, default model placeholders, and dropdown order.
- `apps/api/src/schemas/agent-settings.ts` accepts provider IDs by importing `OPENCODE_PROVIDERS`, so adding `opencode-go` in shared types updates validation.
- `apps/api/src/routes/workspaces/runtime.ts` resolves the selected user-level OpenCode provider for task startup. Any non-platform/non-Scaleway OpenCode provider requires a dedicated OpenCode credential, which is the right behavior for Go.
- `packages/vm-agent/internal/acp/gateway.go` builds the OpenCode config passed through `OPENCODE_CONFIG_CONTENT`. Built-in OpenCode providers such as Zen can be represented by a model string only, without registering a custom provider block.
- `packages/vm-agent/internal/acp/session_host_startup.go` maps selected OpenCode providers to credential env vars. `opencode-go` must map to `OPENCODE_API_KEY`.
- `packages/shared/src/agents.ts` and `packages/vm-agent/internal/acp/gateway.go` both pin the OpenCode install command and both need the version bump.
- `apps/web/src/components/AgentSettingsCard.tsx` presents provider selection and default copy. The current "Default (auto-detect)" copy is misleading now that default is explicitly Zen.
- `apps/web/src/components/ConnectFlow.tsx` still labels OpenCode credential capture as Zen-specific. With Go selectable in settings, generic "OpenCode API Key" copy is clearer.
- Public docs in `apps/www/src/content/docs/docs/guides/agents.md` mention OpenCode Zen and should be updated so users know Go can be selected for GLM 5.2.

## Implementation Plan

1. Persist `/do` state in `.do-state.md` and keep it updated through each phase.
2. Commit this task file to `main` as the durable research and implementation plan artifact.
3. Create the SAM output branch `sam/previously-switched-opencode-use-01kvkm` from current `main` in a separate worktree.
4. Move this task file from `tasks/backlog/` to `tasks/active/` on the feature branch.
5. Add shared OpenCode Go metadata:
   - Extend `OpenCodeProvider` with `opencode-go`.
   - Add `DEFAULT_OPENCODE_GO_MODEL = 'opencode-go/glm-5.2'`.
   - Add `OPENCODE_PROVIDERS['opencode-go']` with label `OpenCode Go`, `OPENCODE_API_KEY`, no base URL requirement, and GLM 5.2 placeholder copy.
   - Insert `opencode-go` near `opencode-zen` in `OPENCODE_PROVIDER_OPTIONS`.
   - Keep `DEFAULT_OPENCODE_PROVIDER = 'opencode-zen'` so existing default behavior does not silently change.
   - Keep `opencode-managed` resolving to Zen for backward compatibility unless code review finds an existing persisted value requiring different behavior.
6. Update OpenCode runtime install metadata:
   - Bump `packages/shared/src/agents.ts` OpenCode install command from `opencode-ai@1.4.3` to a version that exposes GLM 5.2, using the current verified `opencode-ai@1.17.8`.
   - Bump `packages/vm-agent/internal/acp/gateway.go` `installCmd` for OpenCode to the same version.
   - Update tests that assert the catalog install command.
7. Update VM-agent OpenCode config generation:
   - Add a Go default model constant for `opencode-go/glm-5.2`.
   - Resolve default model by provider, so Zen remains `opencode/claude-sonnet-4-6` and Go defaults to `opencode-go/glm-5.2`.
   - Treat `opencode-go` like an OpenCode built-in provider that only needs `config["model"]`.
   - Keep explicit `scaleway`, `platform`, `google-vertex`, `openai-compatible`, `anthropic`, and `custom` behavior unchanged.
   - Map `opencode-go` to `OPENCODE_API_KEY` during startup credential injection.
   - Add Go unit tests for Go config default, explicit Go model preservation, and env var mapping.
8. Update API behavior tests:
   - Verify `opencode-go` is accepted in agent settings.
   - Verify runtime credential resolution requires a dedicated OpenCode credential for `opencode-go`.
   - Verify `opencode-go` does not trigger Scaleway fallback or platform proxy fallback.
   - Verify VM start payloads preserve an `opencode-go` override when present.
9. Update web UI copy and tests:
   - Change misleading provider default copy from auto-detection language to explicit Zen default language.
   - Make Connect Flow OpenCode credential labels generic enough for both Zen and Go.
   - Update provider status helpers/tests so Go appears with the correct label and credential requirements.
   - Run screenshot-backed Playwright visual audit for the agent settings surface.
10. Update public docs:
   - Mention OpenCode Go as an available provider.
   - Document that GLM 5.2 uses `opencode-go/glm-5.2`.
   - Clarify that Zen remains the default provider and Go is selected in agent settings.
11. Run focused local validation:
   - Shared package tests for agent settings and catalog metadata.
   - API route/unit tests for settings, credentials, catalog, and cross-boundary VM payloads.
   - Web unit tests for Connect Flow/status helpers and any settings component tests.
   - `go test ./internal/acp` in `packages/vm-agent`.
12. Run broader validation where feasible:
   - `pnpm lint`.
   - `pnpm typecheck`.
   - `pnpm test`.
   - `pnpm build`.
13. Perform specialist reviews using the relevant project skill checklists:
   - Go specialist for VM-agent config/env handling.
   - Security auditor for credential routing and secret exposure.
   - UI/UX specialist for settings/Connect Flow copy and Playwright audit.
   - Doc-sync validator for public documentation alignment.
   - Task-completion validator before archiving the task.
14. Skip staging deployment and staging verification by explicit user instruction.
15. Open a PR for the output branch, include the no-staging note, and wait for CI checks.
16. Merge only if non-staging checks pass and project merge policy permits merging under the explicit no-staging constraint.

## Acceptance Criteria

- `opencode-go` is a valid OpenCode provider in shared types, API validation, UI settings, and VM startup payloads.
- OpenCode Go appears as a selectable provider in the agent settings UI.
- Selecting OpenCode Go with no custom model defaults to `opencode-go/glm-5.2`.
- Selecting OpenCode Go with an explicit model preserves that model.
- OpenCode Go credentials are injected as `OPENCODE_API_KEY`.
- OpenCode Go does not use Scaleway credential fallback.
- OpenCode Go does not use the SAM platform proxy fallback.
- OpenCode Zen remains the default provider.
- Existing `opencode-managed` persisted settings remain backward compatible.
- The OpenCode runtime install command uses an OpenCode CLI version that exposes GLM 5.2.
- Public docs explain how to use GLM 5.2 through OpenCode Go.
- Focused unit/Go tests cover the new provider behavior.
- Staging is not deployed or mutated for this task.

## Validation Plan

- `pnpm --filter @simple-agent-manager/shared test -- --run tests/unit/agent-settings.test.ts tests/unit/agents.test.ts`
- `pnpm --filter @simple-agent-manager/api test -- --run tests/unit/routes/agent-settings.test.ts tests/unit/routes/opencode-credential-fallback.test.ts tests/unit/routes/agents-catalog.test.ts tests/unit/vm-agent-cross-boundary-contract.test.ts`
- `pnpm --filter @simple-agent-manager/web test -- --run tests/unit/components/ConnectFlow.test.tsx tests/unit/agent-status-sam.test.ts`
- `cd packages/vm-agent && go test ./internal/acp`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- Playwright settings visual audit after local web server startup.

## Staging

Skipped by explicit user instruction. Do not deploy or mutate staging for this work.

## References

- OpenCode Go docs: `https://opencode.ai/docs/go/`
- OpenCode model config docs: `https://opencode.ai/docs/models/`
- OpenCode Go provider metadata: `https://models.dev/providers/opencode-go`
- Prior task: `tasks/archive/2026-05-29-opencode-managed-inference.md`
- Prior default change: `tasks/active/2026-06-16-opencode-zen-default.md`
- Relevant rules:
  - `.claude/rules/14-do-workflow-persistence.md`
  - `.claude/rules/28-credential-resolution-fallback-tests.md`
  - `.claude/rules/41-credential-snapshot-resilience.md`
  - `.claude/rules/17-ui-visual-testing.md`
  - `.claude/rules/01-doc-sync.md`

