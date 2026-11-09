# Weekly supported agent model catalog refresh

## Problem and scope
Refresh hardcoded model choices from primary sources, preserving actual agent/adapter support. SAM task cron-388a31a50f935a40384b844eccead3ab528f84d0958aaafd056e8ccbf99ecd34; output branch sam/weekly-model-catalog-update-9ecd34. Explicit authorization to merge once gates pass. Preserve pre-existing .codex/config.toml change.

## Research (2026-11-09)
- `packages/shared/src/agents.ts`: seven agents; six catalogs in `model-catalog.ts`; Amp intentionally has none.
- Consumers: API `services/model-catalog.ts` and route; web `ModelSelect.tsx` and profile-picker names. OpenCode fetches configured `MODEL_CATALOG_SOURCE_URL` (default models.dev), then cache/static fallback; filters `status: deprecated`, qualifies provider IDs, uses provider display names.
- Claude overview, lifecycle and Code model config support existing choices; no additions/retirements justified. https://platform.claude.com/docs/en/models/overview ; https://platform.claude.com/docs/en/about-claude/model-deprecations ; https://code.claude.com/docs/en/model-config
- Codex adds `gpt-6.1-terra`, CLI >=0.159.0 (SAM pins 0.160.0). API pricing $1/$5 per million, 1,050,000 context; tools require Responses. Update proxy registry alongside picker. https://learn.chatgpt.com/docs/models ; https://developers.openai.com/api/docs/models/gpt-6.1-terra ; https://developers.openai.com/api/docs/deprecations
- Gemini adds `gemini-4-argon`; 3.5 Flash routes to 3.6; 2.5 Pro/Flash are deprecated and route to replacements December 1, while Flash-Lite remains existing-user-only. https://ai.google.dev/gemini-api/docs/models ; https://ai.google.dev/gemini-api/docs/deprecations
- Antigravity docs list newer product models, but SAM pins agy-acp-server 1.4.5. The real adapter probe in tasks/archive/2026-11-05-google-antigravity-agent.md advertises only five Gemini options under API-key auth. Preserve those exact values; do not infer new adapter choices from product-level availability. https://antigravity.google/docs/models/
- Vibe configuration still documents nine choices and Large latest = Large 3. Remove GLM 5.2 after its October 31 retirement; label Medium 3.5 deprecated per model card. Do not assume API-only releases are configured presets. https://docs.mistral.ai/vibe/code/cli/configuration ; https://docs.mistral.ai/resources/changelogs ; https://docs.mistral.ai/models/mistral-medium-3-5-26-04
- Live https://models.dev/api.json snapshot: OpenCode provider now named OpenCode; 83 active records, add iceman-free/crouton-alpha-free/inkling-2-small-free; remove nemotron-3-ultra-free/deepseek-v4-flash. Go: 32 active, add hy4/crouton-alpha-free; remove '(New)' from DeepSeek V4 Pro. https://opencode.ai/docs/models/ ; https://opencode.ai/docs/console/models/
- Relevant prior maintenance and lifecycle lesson: tasks/archive/2026-10-26-agent-model-catalog-refresh.md and packages/shared/.claude/rules/52-model-catalog-lifecycle.md (verify IDs, update both catalogs, protect retired IDs).

## Checklist and acceptance
- [x] Derive supported agents and consumers from code; check primary sources for all static catalogs.
- [x] Update only justified IDs/names/groups and proxy metadata.
- [x] Focused tests cover added IDs, retired exclusions, source names, routing capability and consumer contracts.
- [x] Shared lint/typecheck/tests/build; API/web catalog consumer tests.
- [x] Independent specialist review (completion, test, constitution, docs); resolve findings before archive.
- [x] Staging deployment and authenticated selector/API verification.
- [ ] Open PR, CI green, request CodeRabbit and wait, resolve findings, merge, monitor production smoke.

Release completion is recorded in SAM and the PR after production deploy succeeds.

## Local verification
Shared 51 files / 962 tests passed; shared lint/typecheck/build passed. API catalog service/route: 11 tests passed. Web ModelSelect/profile-picker: 19 tests passed. Main task-only push rejected by required-check branch protection; task record included on output branch rather than bypassing protection.

Independent reviews: task-completion-validator PASS (LOW stale progress evidence addressed); test-engineer PASS (64 focused tests independently rerun); constitution-validator PASS; doc-sync-validator PASS. OpenCode snapshot comparison exactly matches 83 + 32 active ID/name pairs and upstream group names.

Staging: [Deploy Staging 42598925273](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42598925273) succeeded for bb807eccca389c3a601f4b903a60a0b30bdb5339. Authenticated Playwright asserted all seven catalog endpoints, navigated dashboard/projects/settings, and selected Terra/Argon/deprecated Medium/OpenCode Crouton at 1280x800 and 375x667. OpenCode API failure was simulated in the browser to exercise the shipped static fallback. All checks passed, zero page errors/horizontal overflow; all eight screenshots reviewed (readable labels, expected wrapping, no clipping). Browser closed, no profiles saved or resources provisioned. Staging released to next coordinated task.
