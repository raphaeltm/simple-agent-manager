# Weekly agent model catalog update

## Problem

SAM's static model fallback must track current provider model IDs and display names.

## Research

The static catalog serves Claude Code, OpenAI Codex, OpenCode, Mistral Vibe, and Google Gemini. Amp has no static model list. OpenCode normally loads `https://models.dev/api.json`; the static list is a fallback.

Sources checked: [Anthropic models](https://platform.claude.com/docs/en/models/overview), [OpenAI models](https://developers.openai.com/api/docs/models), [Google Gemini models](https://ai.google.dev/gemini-api/docs/models), [Mistral Vibe configuration](https://docs.mistral.ai/vibe/code/cli/configuration), [OpenCode models data](https://models.opencode.ai/api.json), [OpenCode Zen](https://opencode.ai/zen).

Anthropic's model overview lists Sonnet 5.5 at $2 input and $10 output per million tokens with a 1M token context window; the platform proxy metadata uses those values.

## Checklist

- [x] Inspect supported agents and catalog consumers.
- [x] Compare all five static catalogs with primary sources.
- [x] Add source-backed model IDs and fix stale names.
- [x] Update focused catalog tests and platform proxy metadata.
- [x] Run shared package tests, typecheck, lint, and build.
- [x] Review the diff and open the PR. CI, merge, and production monitoring are tracked by the SAM task.

## Acceptance

Known new model IDs appear in static fallback; names match sources; Claude proxy metadata covers its new dropdown option; relevant local and CI checks pass.
