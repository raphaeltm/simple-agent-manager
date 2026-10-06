# Workers AI model deprecation cleanup

## Problem

Cloudflare is deprecating older Workers AI models on May 30, 2026, including `@cf/google/gemma-3-12b-it`. SAM still references that model in active defaults, documentation, and tests. Production Worker configuration already uses non-deprecated models for the main AI proxy and SAM session agent, but utility calls without environment overrides still fall back to the deprecated Gemma 3 model.

## Research Findings

- Cloudflare's May 8, 2026 changelog lists `@cf/google/gemma-3-12b-it` as deprecated on May 30, 2026 and recommends `@cf/zai-org/glm-4.7-flash`, `@cf/google/gemma-4-26b-a4b-it`, and `@cf/moonshotai/kimi-k2.6`.
- Production Worker settings currently set `AI_PROXY_DEFAULT_MODEL = @cf/qwen/qwen3-30b-a3b-fp8` and `SAM_MODEL = @cf/google/gemma-4-26b-a4b-it`, so the main agent/proxy defaults are not the deprecated source.
- `packages/shared/src/constants/ai-services.ts` still uses `@cf/google/gemma-3-12b-it` for `DEFAULT_TASK_TITLE_MODEL`, `DEFAULT_CONTEXT_SUMMARY_MODEL`, `DEFAULT_TTS_CLEANUP_MODEL`, and the platform model catalog.
- `DEFAULT_AI_PROXY_ALLOWED_MODELS` is derived from `PLATFORM_AI_MODELS`, so leaving Gemma 3 in the catalog keeps it allowed by default.
- Documentation and environment examples mirror the deprecated defaults.
- Tests assert the current deprecated defaults and catalog options.
- Relevant postmortems reviewed:
  - `docs/notes/2026-03-25-env-var-single-quote-stripping-postmortem.md`: keep environment writer/reader expectations aligned and tested.
  - `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`: maintain durable review tracking before merge.
  - `docs/notes/2026-04-19-trial-orchestrator-agent-boot-postmortem.md`: verify final behavior across boundaries, not just intermediate state.

## Implementation Checklist

- [x] Replace deprecated utility defaults with a current Workers AI model.
- [x] Remove deprecated Gemma 3 12B from the platform AI model catalog and default allowed model list.
- [x] Update `.env.example` and user-facing docs to reflect the replacement default.
- [x] Update tests and Playwright fixtures that expect Gemma 3 12B in active catalogs/defaults.
- [x] Leave historical specs, archived tasks, and blog posts unchanged unless they are presented as current configuration.
- [x] Run targeted tests for shared model catalog, API utility defaults, and affected web/admin fixtures.
- [x] Run broader validation required by `/do`.

## Acceptance Criteria

- No active runtime default uses a Cloudflare model listed for May 30, 2026 deprecation.
- The admin/platform model catalog no longer offers `@cf/google/gemma-3-12b-it` by default.
- Environment examples and current docs do not recommend deprecated Workers AI models.
- Tests that cover utility defaults and model catalog pass with the replacement model.
