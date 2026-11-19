# Agent model catalog refresh

## Problem

The shared static model catalog drifts as agent providers change their supported models. Refresh only entries backed by current primary sources.

## Research

- `packages/shared/src/agents.ts` defines six agents. Five have static groups in `packages/shared/src/model-catalog.ts`; Amp has no static model list.
- API `apps/api/src/services/model-catalog.ts` serves static lists and fetches OpenCode Zen and Go from `https://models.dev/api.json`, with KV cache and static fallback.
- Official Claude Code model configuration documents native 1M context for Opus 4.7 and later and `[1m]` variants for Opus 4.6 and Sonnet 4.6: https://code.claude.com/docs/en/model-config
- Codex model list supports the existing latest and previous groups: https://learn.chatgpt.com/docs/models
- Mistral Vibe configuration supports the existing groups: https://docs.mistral.ai/vibe/code/cli/configuration
- Gemini model docs limit 2.5 to existing users; the dedicated 3.7 page says its deprecated ID routes to 3.8: https://ai.google.dev/gemini-api/docs/models and https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash
- OpenCode static fallback compared against active Zen and Go IDs/names from https://models.dev/api.json on 2026-10-19.

## Checklist

- [x] Inspect agent types and catalog consumers.
- [x] Check official provider and OpenCode catalog sources.
- [x] Correct Claude and Gemini labels/selectors; sync OpenCode fallback.
- [x] Update focused shared catalog tests.
- [ ] Complete local quality checks, review, staging, CI, and merge.

## Acceptance

- Static OpenCode Zen and Go IDs and names match active models.dev records.
- Claude 4.7/4.8 are represented as native 1M choices without `[1m]` duplicates.
- Gemini labels agree with Google's current status; unchanged Codex/Mistral models remain stable.
- Focused tests and package quality checks pass, PR merges green, production deploy succeeds.
