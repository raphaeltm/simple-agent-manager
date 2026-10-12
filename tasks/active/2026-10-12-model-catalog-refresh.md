# Refresh supported agent model catalog

## Problem
The weekly static fallback and hardcoded agent selectors can drift from provider catalogs.

## Research
Supported agents are defined in `packages/shared/src/agents.ts`: Claude Code, OpenAI Codex, Google Gemini, Mistral Vibe, OpenCode, and Amp. The first five have hardcoded groups in `packages/shared/src/model-catalog.ts`; Amp has none. `apps/api/src/services/model-catalog.ts` uses `https://models.dev/api.json` for dynamic OpenCode groups, with the shared catalog as fallback. The shared tests require Claude Code dropdown models to exist in `PLATFORM_AI_MODELS`.

Sources checked 2026-10-12:
- Anthropic model overview and Haiku 5.5: https://platform.claude.com/docs/en/models/overview and https://platform.claude.com/docs/en/models/haiku-5-5/overview
- OpenAI models: https://developers.openai.com/api/docs/models
- Google models and 3.7 deprecation: https://ai.google.dev/gemini-api/docs/models and https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.7
- Mistral Vibe models: https://docs.mistral.ai/vibe/code/cli/configuration
- OpenCode Zen and Go: https://docs.opencode.ai/docs/zen/ and https://docs.opencode.ai/docs/go/
- Live OpenCode catalog used by SAM: https://models.dev/api.json (`opencode`, `opencode-go`)

## Checklist
- [x] Compare all hardcoded agents with official sources and OpenCode live catalog.
- [x] Add Claude Haiku 5.5 to Claude selector and platform routing registry.
- [x] Synchronize OpenCode static fallback IDs and names with active models.dev entries.
- [x] Label Gemini 3.7 Flash deprecation while preserving existing selection.
- [x] Update focused catalog tests.
- [x] Run local quality checks.
- [ ] Run staging verification.
- [ ] Review, open PR, wait for CI and CodeRabbit, merge, monitor production deploy.

## Acceptance
Catalog only gains provider-confirmed models; stale OpenCode IDs leave the fallback; Claude Haiku is routable; focused tests and repository gates pass; staging selector/API behavior works.
