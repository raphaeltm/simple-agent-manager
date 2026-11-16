# Refresh supported agent model catalog (2026-11-16)

## Request and preflight
Recurring authorized /do maintenance through merge and production smoke. Use SAM-provided output branch `sam/weekly-model-catalog-update-cd752e` and existing isolated workspace; preserve unrelated `.codex/config.toml` changes. Prior refresh #2607 documents main branch protection rejecting task-only pushes; include task on output branch.

Classification: external-api-change, business-logic-change. No new integration, infrastructure, UI implementation, defaults, or credentials. Curated model IDs are provider data, not configurable limits (Constitution X/XI). No additional standing docs/spec changes: search found no current docs naming changed entries.

## Research and sources
- Registry `packages/shared/src/agents.ts`: seven supported agents; six have catalogs, Amp delegates selection to harness.
- Consumers: `apps/web/src/components/ModelSelect.tsx`, API `services/model-catalog.ts` and agent route use shared groups; OpenCode fetches `https://models.dev/api.json`, active `opencode` and `opencode-go` records, static fallback on failure. Profiles use strings; no route contract/schema changes needed.
- Claude model configuration https://code.claude.com/docs/en/model-config and lifecycle https://platform.claude.com/docs/en/about-claude/model-deprecations : current latest models match. Sonnet 4.5 deprecated, retires Nov 30; retain with explicit label for existing configurations. Opus 4.5 still active.
- Codex https://learn.chatgpt.com/docs/models?surface=cli and https://developers.openai.com/api/docs/deprecations : latest IDs and sign-in limitations match current catalog; no change.
- Gemini https://aistudio.google.com/docs/models and https://aistudio.google.com/docs/deprecations : add Carbon/Hydrogen exact IDs. https://geminicli.com/docs/cli/model/ allows any available model via manual/--model; VM gateway sets GEMINI_MODEL. Keep existing supported/legacy labels.
- Antigravity https://antigravity.google/docs/changelog : 1.5.8 adds Carbon/Hydrogen; SAM pins agy-acp-server 1.4.5 with five probed Gemini options (tasks/archive/2026-11-05-google-antigravity-agent.md). Preserve pinned adapter list rather than advertise unsupported options.
- Vibe https://docs.mistral.ai/vibe/code/cli/configuration now explicitly documents `mistral-large-4-0` and `zai-glm-5-3-flash`; model cards https://docs.mistral.ai/models/mistral-large-4-0 and https://docs.mistral.ai/models/zai-glm-5-3-flash confirm releases/tool calling. SAM `packages/vm-agent/internal/acp/vibe_config.go:generateVibeConfig` dynamically registers raw API model IDs; no harness upgrade needed. Do not assume `mistral-large-latest` alias target; label it generically. https://docs.mistral.ai/resources/changelogs checked for retirements; existing Medium deprecated label retained.
- OpenCode https://opencode.ai/docs/models/ and live https://models.dev/api.json fetched to local scratch: 89 OpenCode + 34 Go active entries (previous 83+32). Add seven/three; remove Crouton from both; rename DeepSeek V4.1 Flash to upstream 1017 display name. Keep source order for small diff; only ID/name/group data copied.
- Lifecycle rule 52: proxy registry only covers Anthropic/OpenAI, neither gains IDs. Existing invariant test verifies all picker base IDs in those providers remain registered. No new defaults/pricing required.

## Checklist and acceptance
- [x] Inspect every supported agent, shared consumers, primary sources and pinned harness limitations.
- [ ] Update justified entries and focused catalog regressions; verify OpenCode exact snapshot parity.
- [ ] Shared lint, typecheck, tests, build; focused API/web consumer tests.
- [ ] Independent completion/test/constitution/docs review; address findings before archive.
- [ ] Draft PR then ready with CI and CodeRabbit requested.
- [ ] Deploy free staging installation; authenticated API/selector browser verification; release lease.
- [ ] CI green, review resolved or best-effort outcome recorded, merge; production deploy and basic smoke.
