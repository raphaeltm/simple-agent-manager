# Model Catalog Refresh

## Problem

SAM keeps a static model catalog in `packages/shared/src/model-catalog.ts` for agent model selectors and validation fallback. The catalog drifts as agent providers release, retire, or relabel models. Refresh the hardcoded catalog from current authoritative sources and update focused validation so the selectors remain useful when dynamic catalog lookup is unavailable.

## Research findings

- Supported agents are defined by `packages/shared/src/agents.ts`: `claude-code`, `openai-codex`, `google-gemini`, `mistral-vibe`, `opencode`, and `amp`.
- Static model groups exist only for `claude-code`, `openai-codex`, `google-gemini`, `mistral-vibe`, and `opencode`. `amp` is supported as an agent but has no hardcoded model catalog.
- The API route `apps/api/src/routes/model-catalog.ts` delegates to `apps/api/src/services/model-catalog.ts`. OpenCode can fetch `https://models.dev/api.json` dynamically for `opencode` and `opencode-go`; other agents return the shared static catalog.
- The web client consumes `/api/model-catalog/:agentType` through `apps/web/src/lib/api/agents.ts`.
- Focused validation lives in `packages/shared/tests/model-catalog.test.ts`, `packages/shared/tests/unit/model-catalog-alternative-providers.test.ts`, `apps/api/tests/unit/services/model-catalog.test.ts`, and the web profile selector contract test in `apps/web/tests/unit/components/agent-profiles.test.tsx`.
- Source checks on 2026-09-23:
  - OpenAI API docs list GPT-6 Astra/Sol/Luna; the OpenAI Codex `models.json` catalog lists `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-*`, `gpt-5.5`, hidden legacy `gpt-5.4*`, and `gpt-5.2`.
  - Anthropic model overview lists Claude Fable 5.1, Opus 5.5, Sonnet 5, and Haiku 4.5 as the current lineup; model pages confirm `claude-fable-5-1` and `claude-opus-5-5`.
  - Google Gemini docs list `gemini-3.8-flash` as the latest stable Flash model and keep `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.1-pro-preview`, and 2.5 models.
  - Mistral Vibe CLI docs list chat-capable model aliases `mistral-medium-latest`, `zai-glm-5-3`, `zai-glm-5-2`, `mistral-large-latest`, `mistral-small-latest`, `codestral-latest`, and `ministral-*-latest`.
  - `https://models.dev/api.json` lists updated OpenCode Zen/Go provider-qualified active models, including GPT-6, Gemini 3.8, Claude Fable 5.1, Claude Opus 5.5, Grok 4.7, Muse Spark 1.3, DeepSeek V4.1 Flash, Qwen 3.8, and newer MiMo/Hy/Space Bunny entries.

## Checklist

- [x] Load SAM MCP task instructions and `/do` workflow state.
- [x] Inspect supported agent definitions and catalog consumers.
- [x] Check authoritative provider/catalog sources.
- [x] Update `packages/shared/src/model-catalog.ts` for sourced model/group/display-name changes.
- [x] Update platform model registry only where required by existing catalog invariants.
- [x] Update focused shared/API/UI tests for changed model groups and IDs.
- [x] Run focused package validation.
- [x] Run `/do` review gates.
- [ ] Open PR, wait for CI and CodeRabbit, merge when green, and monitor production deploy.

## Validation

- `pnpm --filter @simple-agent-manager/shared test -- tests/model-catalog.test.ts tests/unit/model-catalog-alternative-providers.test.ts`
- `pnpm --filter @simple-agent-manager/shared lint`
- `pnpm --filter @simple-agent-manager/shared typecheck`
- `pnpm --filter @simple-agent-manager/shared test`
- `pnpm --filter @simple-agent-manager/shared build`
- `pnpm quality:file-sizes`
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/agent-profiles.test.tsx`
- `pnpm --filter @simple-agent-manager/web typecheck`
- `pnpm --filter @simple-agent-manager/web lint` — passes with existing React hook warnings
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/model-catalog.test.ts`
- Live `models.dev` comparison script: active `opencode`/`opencode-go` IDs match the shared static fallback exactly (`expected: 108`, `actual: 108`, no missing or extra IDs).

## Review gates

Note: `packages/shared/src/constants/ai-services.ts` was kept under the mandatory 800-line limit by moving the agent-loop filtering helper to `packages/shared/src/constants/ai-model-filtering.ts` while preserving the existing export surface.

- task-completion-validator: PASS — the implementation covers the task checklist and acceptance criteria, including the live OpenCode fallback comparison.
- test-engineer: PASS — changed catalog groups/model IDs are covered by focused shared tests, the API service contract test, and the web selector test.
- constitution-validator: PASS — the new values are intentional hardcoded model catalog metadata for this maintenance task, and no new deployment URLs, timeouts, service limits, or environment-specific identifiers were introduced.

## Acceptance criteria

- Static catalog entries for all hardcoded agent catalogs match current authoritative sources closely enough to be a useful selector/fallback.
- Retained older models are intentionally labeled as previous, legacy, or hidden/older based on source evidence.
- OpenCode static fallback is synchronized with active `opencode` and `opencode-go` entries from SAM's configured `models.dev` source path.
- Focused tests prove the updated high-value model IDs, group labels, and dynamic OpenCode normalization behavior.
- Local validation and PR/CI gates pass before merge.
