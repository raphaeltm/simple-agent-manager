# Make OpenCode default to Zen credentials

## Problem

OpenCode setup currently presents the default path as a Scaleway integration. The shared catalog uses `SCW_SECRET_KEY`, the runtime callback can silently reuse Scaleway cloud credentials when no OpenCode key exists, and the VM agent generates a Scaleway OpenCode config by default. The guided/default OpenCode path should instead be Zen-only and ask for an OpenCode Zen key.

Source of truth: SAM idea `01KV8H0J9028W2G89V4EQNTDXX`.

## Research Findings

- `packages/shared/src/agents.ts` describes OpenCode as Scaleway-backed, uses `SCW_SECRET_KEY`, links to Scaleway, and exposes `fallbackCloudProvider: 'scaleway'`.
- `packages/shared/src/types/agent-settings.ts` has stale `opencode-managed` metadata and no canonical Zen provider helper. `null` currently means "default" but runtime treats that as eligible for Scaleway fallback.
- `apps/api/src/routes/workspaces/runtime.ts` reads `agent_settings.opencodeProvider`; unset/invalid provider becomes `null`, then permits Scaleway fallback and later platform proxy fallback.
- `apps/api/src/services/composable-credentials/agent-sync.ts` syncs legacy Connect saves into `cc_*`, but OpenCode configurations currently get `settings_json = NULL`.
- `apps/web/src/components/ConnectFlow.tsx` is generic and displays shared catalog metadata, so fixing catalog metadata updates its OpenCode prompt. It still saves through the legacy validated path, which syncs into composable credentials.
- `packages/vm-agent/internal/acp/gateway.go` sets `DefaultOpencodeModel` to `scaleway/qwen3-coder-30b-a3b-instruct`, defaults provider to `scaleway`, and falls back to a Scaleway provider block for unknown providers.
- `packages/vm-agent/internal/acp/session_host_startup.go` logs unset OpenCode provider as Scaleway.
- Existing tests assert the old Scaleway default: shared catalog tests, agent settings metadata tests, `opencode-credential-fallback.test.ts`, and Go VM-agent config/env tests.
- Relevant retained lessons: `.claude/rules/28-credential-resolution-fallback-tests.md` requires behavioral credential fallback coverage; `.claude/rules/41-credential-snapshot-resilience.md` requires credential resolution to skip bad rows rather than fail closed with 500.

## Checklist

- [x] Add shared OpenCode Zen constants and provider resolver helpers.
- [x] Update OpenCode catalog metadata to use `OPENCODE_API_KEY`, OpenCode auth/docs URL, and no default Scaleway fallback.
- [x] Update OpenCode provider metadata so the visible guided/default provider is `OpenCode Zen` with `opencode/...` model examples; preserve `opencode-managed` only as an accepted alias if needed.
- [x] Make legacy Connect-to-CC sync write OpenCode Zen settings (`providerId: opencode-zen`, default model) for OpenCode API-key credentials.
- [x] Update runtime `/agent-key` resolution so unset/invalid OpenCode provider resolves to Zen, requires a user OpenCode key, and does not fall back to Scaleway or platform proxy.
- [x] Preserve explicit `scaleway` behavior only when selected explicitly.
- [x] Preserve explicit `platform` behavior only when selected explicitly.
- [x] Update VM agent OpenCode defaults to Zen model/env behavior and remove unknown-provider fallback to Scaleway.
- [x] Update UI status/copy helpers that still treat unset OpenCode provider as Scaleway.
- [x] Update public docs if any user-facing docs mention OpenCode Scaleway defaults.
- [x] Add/adjust tests for shared metadata/helpers, Connect/CC sync settings, runtime fallback behavior, VM-agent config/env injection, and visible OpenCode Zen labels.

## Acceptance Criteria

- [x] Default/guided OpenCode setup asks for an OpenCode Zen API key, not a Scaleway key.
- [x] Saving an OpenCode key creates/syncs a composable configuration with Zen provider metadata.
- [x] Unconfigured OpenCode returns a clear setup-required/not-found response instead of silently falling back to Scaleway or platform proxy.
- [x] Explicit Scaleway remains available only when the provider is explicitly set to `scaleway`.
- [x] Explicit platform remains routed through the SAM platform proxy path.
- [x] The VM agent default OpenCode config uses an `opencode/...` Zen model and `OPENCODE_API_KEY`, with no Scaleway provider block.
- [x] Tests cover the UI/API/config/runtime/VM path sufficiently to prevent a future silent Scaleway fallback regression.

## Verification

- `pnpm lint` passes with existing warning baseline.
- `pnpm typecheck` passes.
- `pnpm test` passes.
- `pnpm build` passes.
- `pnpm --filter @simple-agent-manager/shared test -- --run tests/unit/agent-settings.test.ts tests/unit/agents.test.ts` passes.
- `pnpm --filter @simple-agent-manager/api test -- --run tests/unit/services/composable-credentials-agent-sync.test.ts tests/unit/routes/opencode-credential-fallback.test.ts tests/unit/routes/agents-catalog.test.ts tests/unit/routes/agent-settings.test.ts` passes.
- `pnpm --filter @simple-agent-manager/web test -- --run tests/unit/components/ConnectFlow.test.tsx tests/unit/agent-status-sam.test.ts` passes.
- `cd packages/vm-agent && go test ./internal/acp` passes.
- Worker test `npx vitest run --config vitest.workers.config.ts tests/workers/composable-credentials-wiring.test.ts --no-fileParallelism --maxWorkers=1` is blocked by a local `workerd` segmentation fault before test collection.
- Playwright audit command for `settings-credentials-audit`, `connections-ui-audit`, and `agent-settings-audit` is blocked locally because Playwright Chromium/headless-shell `1217` is missing and browser install hangs after download with a partial cache.

## Review Notes

- Security review: pass. The default Zen path requires a user-owned OpenCode credential, does not inject platform-owned credentials into tenant workspaces, and keeps credentials in env/config paths rather than CLI arguments or logs.
- Environment/docs review: pass. No new Worker secrets or bindings were introduced; public docs and user-visible labels now describe `OPENCODE_API_KEY` and OpenCode Zen.
- Cloudflare review: pass with local worker-test blocker. The new sync SQL uses bound parameters and no migrations/bindings changed, but the focused Workers test could not run locally because `workerd` crashed before collection.
- Go review: pass. The VM-agent OpenCode defaults now use the Zen model/env path, explicit Scaleway remains supported, and `go test ./internal/acp` passes.
- UI/UX review: pass with visual-audit blocker. The web changes are copy/status/placeholder only and have unit coverage, but screenshot-backed Playwright audit could not run because the browser cache/install is broken in this workspace.
- Task completion review: pass with the two environment blockers above. Acceptance criteria are covered by code changes plus shared/API/web/Go tests.

## References

- Idea: `01KV8H0J9028W2G89V4EQNTDXX`
- Previous crashed session: `e56fe4dc-a779-411c-b165-7eaf760ba2ff`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/41-credential-snapshot-resilience.md`
