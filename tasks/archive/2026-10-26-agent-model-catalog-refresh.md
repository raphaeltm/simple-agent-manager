# Agent model catalog refresh

## Problem and scope
Refresh the hardcoded shared agent catalog from primary sources. SAM-managed task 01M5VQ1DA5KABE9FWHV85G5STD uses the pre-created output branch sam/weekly-model-catalog-update-5g5std; preserve unrelated .codex/config.toml changes.

## Research and sources (2026-10-26)
- `packages/shared/src/agents.ts`: six supported agents; five static catalogs; Amp has none.
- Shared catalog feeds `apps/api/src/services/model-catalog.ts`, the `/api/model-catalog/:agentType` route, `apps/web/src/components/ModelSelect.tsx`, and profile-picker display names. OpenCode uses models.dev, KV cache, then this static fallback.
- Claude models and native 1M / `[1m]` choices remain current: https://platform.claude.com/docs/en/models/overview and https://code.claude.com/docs/en/model-config
- Codex IDs remain useful, but official docs now explicitly retire GPT-5.5/5.4 for ChatGPT sign-in (API-key sessions remain supported) and deprecate GPT-5.2 for ChatGPT sign-in. Label these legacy choices: https://learn.chatgpt.com/docs/models and https://developers.openai.com/api/docs/models
- Gemini groups and legacy labels remain current: https://ai.google.dev/gemini-api/docs/models and https://ai.google.dev/gemini-api/docs/deprecations
- Vibe's nine documented configuration choices remain current: https://docs.mistral.ai/vibe/code/cli/configuration . Its Large latest alias is still documented as Large 3; do not infer an alias change from the separate Large 4 release. New GLM 5.3 Flash is an API release, not a documented Vibe configuration choice. GLM 5.2 retires 2026-10-31: https://docs.mistral.ai/resources/changelogs
- https://opencode.ai/docs/models/ uses models.dev. SAM's configured default https://models.dev/api.json has 82 active Zen and 30 active Go records. Add six IDs, remove seven absent/deprecated IDs; preserve upstream names exactly. This is a static fallback refresh, not a dynamic catalog behavior change.

## Checklist and acceptance
- [x] Determine supported agents and trace consumers.
- [x] Fetch official sources for all five static catalogs.
- [x] Match OpenCode fallback ID/name pairs to all active Zen/Go records.
- [x] Clarify Codex legacy groups and sign-in availability labels.
- [x] Clearly label GLM 5.2 retirement while keeping the usable preset.
- [x] Update focused regression tests for additions/removals and retirement label.
- [x] Run shared lint/typecheck/tests/build and API catalog contract tests.
- [x] Complete specialist review and archive this implementation record.
- [x] Deploy staging and verify catalog selector/API behavior.

Release continuation: PR/CI/CodeRabbit/merge and production deployment are owned by the same SAM task; completion is recorded in the PR and SAM evidence after release, not inferred from this archived implementation record.

## Validation
Shared lint/typecheck/build passed; 48 files / 908 tests passed. API model-catalog service and route contracts: 2 files / 11 tests passed. Independent local review: task-completion-validator, test-engineer, constitution-validator PASS; doc-sync-validator LOW wording finding addressed. Source comparison: exactly 82 Zen + 30 Go ID/name pairs. Release gates below remain pending and are tracked in the PR and SAM task.

Staging: [Deploy Staging 40297990013](https://github.com/raphaeltm/simple-agent-manager/actions/runs/40297990013) succeeded for 7d8cc60fb39b3f71c36aa4b4e269563510101015. Authenticated Playwright loaded dashboard/projects/settings, verified Codex/Mistral labels via API and selectors, and confirmed 112 OpenCode models with all six additions. Mobile overflow and browser page-error checks passed. No settings saved or resources provisioned. Web ModelSelect/profile-picker tests: 18 passed. Local browser dependencies were installed to enable this verification. The staging completion event successfully woke this chat; fallback was cancelled unused.
