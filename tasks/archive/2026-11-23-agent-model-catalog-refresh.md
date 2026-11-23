# Refresh supported agent model catalog (2026-11-23)

## Request and preflight
Recurring /do maintenance authorized through green CI, merge and production smoke. Use provisioned isolated workspace/output branch `sam/weekly-model-catalog-update-dfd1a2`. Preserve unrelated `.codex/config.toml`. Previous refresh records main protection rejects task-only pushes; keep task in output branch.

Classification: external-api-change, business-logic-change. Curated provider IDs are static data under Constitution X/XI. No new integration, credentials, defaults, infrastructure or UI implementation. Public docs get a targeted drift audit; unchanged interfaces need no new specs.

## Research and impact
- `packages/shared/src/agents.ts`: seven agents; six catalogs; Amp selects through its harness.
- `model-catalog.ts` -> API `services/model-catalog.ts` -> models route -> web `ModelSelect.tsx`. Non-OpenCode catalogs static; OpenCode uses configured `MODEL_CATALOG_SOURCE_URL`, default https://models.dev/api.json, active `opencode`/`opencode-go` records; fallback is shared static data. No schema changes.
- Claude: https://platform.claude.com/docs/en/models/overview , https://platform.claude.com/docs/en/about-claude/model-deprecations , https://code.claude.com/docs/en/model-config . No change: Fable 5.2 and other public models match; restricted Mythos intentionally excluded. Sonnet 4.5 still deprecated until Nov 30; Opus 4.5 active.
- Codex: https://learn.chatgpt.com/docs/models (official Codex models redirect) confirms `gpt-6.2-astra`/`gpt-6.2-sol`, existing GPT-6 choices remain supported. https://developers.openai.com/api/docs/models/gpt-6.2-astra and /gpt-6.2-sol establish exact IDs, 1,050,000 context, $8/$40 and $2/$10 per million input/output. https://developers.openai.com/api/docs/deprecations checked; no newly retired picker IDs. Compatibility probe below rejects these on SAM’s pinned CLI, so preserve the native catalog/proxy registry and existing legacy sign-in labels; defer the coordinated runtime upgrade.
- Gemini: https://aistudio.google.com/docs/models and /docs/deprecations confirm `gemini-4-neon` (Nov 18 release). Existing preview and routing/retirement labels remain accurate. Gemini CLI accepts explicit model IDs.
- Antigravity: https://antigravity.google/docs/cli/acp and /docs/changelog checked. SAM manifest still pins standalone ACP 1.4.5, not new native CLI; preserve five options probed for API-key auth (Nov 5 task and Nov 16 refresh), do not copy new CLI's wider list.
- Mistral Vibe: https://docs.mistral.ai/models/deepseek-v4-flash-1017 verifies `deepseek-v4-1-flash-1017`, tool calling and public preview status; https://docs.mistral.ai/vibe/code/cli/configuration supports custom models. SAM `vibe_config.go:generateVibeConfig` registers raw IDs dynamically. https://docs.mistral.ai/models and /resources/changelogs checked. Retain existing aliases and deprecated Medium label.
- OpenCode: https://opencode.ai/docs/models/ and live https://models.dev/api.json checked Nov 23. Six additions (five OpenCode, one Go); twelve removals (nine OpenCode, three Go); no name changes. Static fallback must match active ID/name pairs exactly. Keep upstream order for a small diff.
- Lessons: rule 52 requires proxy registration for picker IDs; Nov 16 refresh caught marketing integration-data drift, so include `apps/www/src/data/integrations/agents.json` in audit.

## Checklist / acceptance
- [x] Audit every supported agent and primary sources.
- [x] Apply source-backed additions/removals/groups; preserve registry because native Codex additions fail pinned-runtime probe.
- [x] Update focused catalog tests and affected API/web fallback contracts.
- [x] Run shared lint/typecheck/test/build plus focused API/web consumer checks: 993 shared, 11 API, 19 web tests pass.
- [x] Independent completion, test, constitution/docs reviews PASS on corrected final diff.
- [x] PR #2986 opened draft then ready; full CI and CodeRabbit requested together.
- [ ] Staging deployment and live catalog verification; release lease.
- [ ] Green CI, resolved reviews/best-effort CodeRabbit outcome, merge and production smoke.

## Compatibility correction before release
Real prompt verification: installed Codex CLI0.171.0 answered OK with GPT-6.2 Sol. Stock CLI0.160.0 using the same ChatGPT account rejected that exact model with `model_not_found` and warned its metadata was missing. SAM manifest pins companion CLI0.160.0/ACP2.1.1; adapter2.1.1's npm dependency ^0.159.1 also bundles an older CLI (`dist/index.js:startCodexConnection` resolves its own dependency). SAM has heavily patched versions/provenance, so a blind runtime bump is not maintenance-safe. Therefore WITHDRAW the proposed native Codex additions and proxy metadata: leave Codex unchanged as for pinned Antigravity. GPT-6.2 remains available through source-verified OpenCode records only. Follow-up: `tasks/backlog/2026-11-23-codex-gpt62-runtime-compatibility.md`. Official CLI changelog https://learn.chatgpt.com/docs/changelog confirms0.171.0 adds the new catalog models. No registry/default changes remain.

Local checks before correction: shared995/API11/web19/www63 passed; shared lint/typecheck/build and marketing lint/typecheck/build passed. Reviews confirmed117 exact active OpenCode snapshot pairs, retracting a reviewer's false Sonnet omission caused by a multiline regex. Final focused checks and review run again after correction.

## Browser and review evidence
- Local existing chat-options audit:8/8 mobile375x667/desktop1280x800 pass, including 200-character unbroken model ID.
- Additional temporary browser harness reused the real ProjectChat and ModelSelect with mocked profiles, searched and selected Gemini4Neon, Mistral DeepSeek preview and OpenCode GPT6.2Sol at both viewports:6/6 pass. Input shows the human-readable name plus ID after selection; one override is recorded. Screenshots in `tasks/evidence/2026-11-23-model-catalog/` reviewed: readable wrapping, no horizontal overflow or clipping. No UI implementation/layout changes.
- Independent final constitution/docs and test/completion reviewers PASS after native-Codex compatibility correction. GitHub LongCat finding resolved against re-fetched configured models.dev feed (both free records explicitly deprecated; SHA2561927fb69e462e15bf928e4dc747d67aef692990ab1cbfac6e20b3d7be3a43ab7). Pricing finding resolved by withdrawing unsupported native additions; follow-up includes cache pricing.
- CodeRabbit requested on readiness at09:17 UTC via trusted label workflow45145698737, completed with no actionable comments. Incremental review remains observed in PR.
- Runtime code is final at6353af4c6d1fa816e3dfe3844ae846b41855801c. Later archival/evidence commits do not change runtime bytes. Staging deployment45146818793 targets that runtime commit; release gates and production result remain tracked in PR #2986 and SAM task.
