# Dynamic OpenCode Model Catalog

## Problem

SAM's OpenCode model selector uses a static shared catalog that does not reflect the current OpenCode Zen and OpenCode Go model lists. Users should see current OpenCode models without waiting for a code change, while still having a static fallback when the upstream catalog is unavailable.

## Research Findings

- `packages/shared/src/model-catalog.ts` is the current static source used by `ModelSelect`.
- `apps/web/src/components/ModelSelect.tsx` imports `getModelGroupsForAgent()` directly and has no dynamic loading path.
- `apps/web/src/components/AgentSettingsCard.tsx` already knows the selected OpenCode provider, but it does not pass that provider into `ModelSelect`.
- Agent profiles currently persist only `model`, not `opencodeProvider`, so OpenCode model options must remain fully qualified as `provider/model`.
- `apps/api/src/routes/agents-catalog.ts` is only the agent connection/status catalog; there is no model-catalog API endpoint.
- Official OpenCode behavior and local CLI checks show `opencode models --refresh` reads Models.dev, but CLI output is credential-sensitive. Without `OPENCODE_API_KEY`, `opencode-go` may not appear even though Models.dev exposes it.
- Models.dev `https://models.dev/api.json` is CORS-enabled and Cloudflare-cached. The full catalog is about 2.4 MB, so the browser should not fetch it directly for a settings dropdown.
- Current Models.dev snapshot lists OpenCode Zen (`opencode`) with 46 active models and OpenCode Go (`opencode-go`) with 13 active models. Deprecated models should not appear in the default dropdown.
- Relevant retained lessons: `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/01-doc-sync.md`, `.claude/rules/08-architecture.md`, `.specify/memory/constitution.md` Principle XI.

## Implementation Checklist

- [ ] Add shared constants/types for a dynamic model catalog response and Models.dev provider IDs used by SAM.
- [ ] Expand the static OpenCode fallback catalog to active OpenCode Zen and OpenCode Go models from Models.dev.
- [ ] Add an authenticated API route that returns model groups for an agent type.
- [ ] For OpenCode, fetch Models.dev server-side, normalize relevant providers into `ModelGroup[]`, filter deprecated models by default, cache the normalized payload in KV with configurable TTL, and fall back to the static shared catalog on upstream/cache failures.
- [ ] Keep non-OpenCode agents on the existing static catalog through the same API shape.
- [ ] Update API route wiring and tests for static, dynamic, cached, and upstream-failure behavior.
- [ ] Update the web API client and `ModelSelect` to optionally load dynamic model groups.
- [ ] Make OpenCode settings use the API-backed `ModelSelect`, filtered by selected provider when appropriate.
- [ ] Preserve a static fallback in the web component if the API request fails.
- [ ] Add/adjust web unit tests for loading, provider filtering, and fallback behavior.
- [ ] Add or update Playwright visual audit coverage for the changed agent settings model selector.
- [ ] Update public docs/configuration references for the new dynamic model catalog behavior and new environment variables.
- [ ] Run focused tests, full validation, specialist reviews, staging verification, PR, and merge per `/do`.

## Acceptance Criteria

- OpenCode model selection loads options from a SAM API endpoint rather than directly from the shared static catalog.
- The API endpoint uses Models.dev for OpenCode when available and returns static fallback models when unavailable.
- The OpenCode dropdown includes active `opencode/*` and `opencode-go/*` models, including `opencode-go/glm-5.2`.
- Deprecated Models.dev entries are excluded from the default dropdown.
- The OpenCode settings UI narrows the dropdown to Zen models when Zen is selected and Go models when Go is selected, while preserving full model IDs.
- Custom/openai-compatible OpenCode providers still allow freeform model entry.
- Non-OpenCode agents continue to work with their existing static model catalog.
- Tests cover API normalization/cache/fallback behavior and web loading/fallback behavior.
- Public docs mention that OpenCode model options are loaded dynamically from Models.dev with a static fallback.

## References

- SAM idea: `01KW3X009CGZQY0QP0SN2V6G0R`
- OpenCode model docs: `https://opencode.ai/docs/models/`
- OpenCode Go docs: `https://opencode.ai/docs/go/`
- Models.dev API: `https://models.dev/api.json`
- Models.dev OpenCode Zen provider: `https://models.dev/providers/opencode`
- Models.dev OpenCode Go provider: `https://models.dev/providers/opencode-go`
