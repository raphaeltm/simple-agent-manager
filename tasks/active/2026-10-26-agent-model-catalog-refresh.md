# Agent model catalog refresh

## Problem and scope
Refresh the hardcoded shared agent catalog from primary sources. SAM-managed task 01M5VQ1DA5KABE9FWHV85G5STD uses the pre-created output branch sam/weekly-model-catalog-update-5g5std; preserve unrelated .codex/config.toml changes.

## Research and sources (2026-10-26)
- `packages/shared/src/agents.ts`: six supported agents; five static catalogs; Amp has none.
- Shared catalog feeds `apps/api/src/services/model-catalog.ts`, the `/api/agents/:agentType/models` route, `apps/web/src/components/ModelSelect.tsx`, and profile-picker display names. OpenCode uses models.dev, KV cache, then this static fallback.
- Claude models and native 1M / `[1m]` choices remain current: https://platform.claude.com/docs/en/models/overview and https://code.claude.com/docs/en/model-config
- Codex groups remain current: https://learn.chatgpt.com/docs/models and https://developers.openai.com/api/docs/models
- Gemini groups and legacy labels remain current: https://ai.google.dev/gemini-api/docs/models and https://ai.google.dev/gemini-api/docs/deprecations
- Vibe's nine built-in presets remain current: https://docs.mistral.ai/vibe/code/cli/configuration . Its Large latest alias is still documented as Large 3; do not infer an alias change from the separate Large 4 release. New GLM 5.3 Flash is an API release, not a documented Vibe built-in preset. GLM 5.2 retires 2026-10-31: https://docs.mistral.ai/resources/changelogs
- https://opencode.ai/docs/models/ uses models.dev. SAM's configured default https://models.dev/api.json has 82 active Zen and 30 active Go records. Add six IDs, remove seven absent/deprecated IDs; preserve upstream names exactly. This is a static fallback refresh, not a dynamic catalog behavior change.

## Checklist and acceptance
- [x] Determine supported agents and trace consumers.
- [x] Fetch official sources for all five static catalogs.
- [ ] Match OpenCode fallback ID/name pairs to all active Zen/Go records.
- [ ] Clearly label GLM 5.2 retirement while keeping the usable preset.
- [ ] Update focused regression tests for additions/removals and retirement label.
- [ ] Run shared lint/typecheck/tests/build and API catalog contract tests.
- [ ] Complete specialist review and archive this implementation record.
- [ ] Deploy staging and verify catalog selector/API behavior.
- [ ] Open PR, resolve CI/review, merge green and verify production deployment.

## Validation
Pending.
