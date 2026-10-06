# Refresh supported agent model catalog

SAM uses `packages/shared/src/model-catalog.ts` as a selector fallback. The supported agent registry lists Claude Code, Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp; Amp has no hardcoded models. The API fetches OpenCode Zen and Go from models.dev and omits deprecated models, so its fallback should match that feed. The other four providers' current official lists support their existing entries.

## Sources
- [Anthropic model list](https://platform.claude.com/docs/en/models/overview)
- [OpenAI model list](https://developers.openai.com/api/docs/models)
- [Google Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Mistral Vibe model configuration](https://docs.mistral.ai/vibe/code/cli/configuration)
- [OpenCode model source](https://models.dev/api.json)

## Checklist
- [x] Inspect supported agents and catalog consumers.
- [x] Compare every hardcoded agent with official sources and OpenCode with models.dev.
- [x] Align OpenCode fallback with current non-deprecated Zen and Go entries.
- [x] Update focused tests for added and removed IDs.
- [x] Run package quality checks and review.
- [x] Verify staging catalog; merge green PR pending.

## Acceptance criteria
The OpenCode fallback contains current non-deprecated source IDs; new and removed IDs are covered by tests. Other agents remain unchanged unless the official sources justify a change.
