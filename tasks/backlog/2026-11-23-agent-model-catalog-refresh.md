# Refresh supported agent model catalog (2026-11-23)

## Request and preflight
Recurring /do maintenance authorized through green CI, merge and production smoke. Use provisioned isolated workspace/output branch `sam/weekly-model-catalog-update-dfd1a2`. Preserve unrelated `.codex/config.toml`. Previous refresh records main protection rejects task-only pushes; keep task in output branch.

Classification: external-api-change, business-logic-change. Curated provider IDs are static data under Constitution X/XI. No new integration, credentials, defaults, infrastructure or UI implementation. Public docs get a targeted drift audit; unchanged interfaces need no new specs.

## Research and impact
- `packages/shared/src/agents.ts`: seven agents; six catalogs; Amp selects through its harness.
- `model-catalog.ts` -> API `services/model-catalog.ts` -> models route -> web `ModelSelect.tsx`. Non-OpenCode catalogs static; OpenCode uses configured `MODEL_CATALOG_SOURCE_URL`, default https://models.dev/api.json, active `opencode`/`opencode-go` records; fallback is shared static data. No schema changes.
- Claude: https://platform.claude.com/docs/en/models/overview , https://platform.claude.com/docs/en/about-claude/model-deprecations , https://code.claude.com/docs/en/model-config . No change: Fable 5.2 and other public models match; restricted Mythos intentionally excluded. Sonnet 4.5 still deprecated until Nov 30; Opus 4.5 active.
- Codex: https://learn.chatgpt.com/docs/models (official Codex models redirect) confirms `gpt-6.2-astra`/`gpt-6.2-sol`, existing GPT-6 choices remain supported. https://developers.openai.com/api/docs/models/gpt-6.2-astra and /gpt-6.2-sol establish exact IDs, 1,050,000 context, $8/$40 and $2/$10 per million input/output. https://developers.openai.com/api/docs/deprecations checked; no newly retired picker IDs. Add registry/pricing in `constants/ai-services.ts` per lifecycle rule 52. Preserve existing legacy sign-in labels.
- Gemini: https://aistudio.google.com/docs/models and /docs/deprecations confirm `gemini-4-neon` (Nov 18 release). Existing preview and routing/retirement labels remain accurate. Gemini CLI accepts explicit model IDs.
- Antigravity: https://antigravity.google/docs/cli/acp and /docs/changelog checked. SAM manifest still pins standalone ACP 1.4.5, not new native CLI; preserve five options probed for API-key auth (Nov 5 task and Nov 16 refresh), do not copy new CLI's wider list.
- Mistral Vibe: https://docs.mistral.ai/models/deepseek-v4-flash-1017 verifies `deepseek-v4-1-flash-1017`, tool calling and public preview status; https://docs.mistral.ai/vibe/code/cli/configuration supports custom models. SAM `vibe_config.go:generateVibeConfig` registers raw IDs dynamically. https://docs.mistral.ai/models and /resources/changelogs checked. Retain existing aliases and deprecated Medium label.
- OpenCode: https://opencode.ai/docs/models/ and live https://models.dev/api.json checked Nov 23. Six additions (five OpenCode, one Go); twelve removals (nine OpenCode, three Go); no name changes. Static fallback must match active ID/name pairs exactly. Keep upstream order for a small diff.
- Lessons: rule 52 requires proxy registration for picker IDs; Nov 16 refresh caught marketing integration-data drift, so include `apps/www/src/data/integrations/agents.json` in audit.

## Checklist / acceptance
- [x] Audit every supported agent and primary sources.
- [ ] Apply source-backed additions/removals/groups and registry metadata.
- [ ] Update focused catalog/registry tests and any affected consumer contracts.
- [ ] Run shared lint/typecheck/test/build plus focused API/web consumer checks.
- [ ] Complete independent local completion, test, constitution/docs reviews before archive.
- [ ] Draft PR, ready candidate, CI and CodeRabbit review request.
- [ ] Staging deployment and live catalog verification; release lease.
- [ ] Green CI, resolved reviews/best-effort CodeRabbit outcome, merge and production smoke.
