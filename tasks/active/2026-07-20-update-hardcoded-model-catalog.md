# Update hardcoded model catalog from authoritative sources

## Problem

SAM's static model catalog is a user-facing fallback and validation source for supported coding agents. Provider catalogs and lifecycle states change frequently, so stale IDs can present retired models or omit currently supported choices.

## Research findings

- Supported agent types are defined in `packages/shared/src/agents.ts`. Static model groups currently exist for Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, and OpenCode; Amp has no hardcoded model catalog.
- `packages/shared/src/model-catalog.ts` feeds shared validation and the web/API selectors. OpenCode normally loads dynamically through `apps/api/src/services/model-catalog.ts`, but this file remains its outage fallback.
- Anthropic's model-status documentation marks `claude-sonnet-4-20250514` retired as of 2026-06-15 and `claude-opus-4-1-20250805` deprecated with retirement scheduled for 2026-08-05. Current Claude 5 and Claude 4 IDs otherwise match the static catalog.
- OpenAI's official model catalog confirms the GPT-5.6 Sol/Terra/Luna, GPT-5.5, and GPT-5.4 families. Deprecated coding/reasoning models remain useful only when explicitly labeled legacy/deprecated.
- Google's Gemini model and deprecation documentation says `gemini-2.0-flash` was shut down on 2026-06-01, `gemini-3.1-pro-preview` is the active Pro ID, and `gemini-3.1-flash-lite` is GA.
- Mistral's official model catalog confirms the current Mistral Medium 3.5, Mistral Small 4, Mistral Large 3, Devstral 2, Codestral, Magistral, and Ministral entries.
- SAM's configured Models.dev source (`https://models.dev/api.json`) currently exposes changed active sets for `opencode` and `opencode-go`; the static fallback must mirror those normalized active records.
- Relevant prior work: `tasks/archive/2026-05-20-sync-model-catalog-api-offerings.md` and `tasks/archive/2026-06-27-dynamic-opencode-model-catalog.md`.

## Implementation checklist

- [ ] Remove retired Claude and Gemini IDs from static choices.
- [ ] Correct lifecycle labels and the Gemini 3.1 Pro preview ID.
- [ ] Add the current Gemini 3.1 Flash-Lite choice.
- [ ] Synchronize the OpenCode Zen and Go fallback groups with active Models.dev records and display names.
- [ ] Update focused catalog tests for changed IDs, lifecycle exclusions, and representative OpenCode entries.
- [ ] Run shared-package lint, typecheck, tests, and build plus the repository quality suite required by `/do`.
- [ ] Complete specialist validation, staging verification, PR review/CI, merge, and production deployment monitoring.

## Acceptance criteria

- Every hardcoded catalog is supported by a current primary source.
- Retired Claude Sonnet 4 and Gemini 2.0 Flash are absent.
- Gemini uses `gemini-3.1-pro-preview` and includes `gemini-3.1-flash-lite`.
- OpenCode fallback IDs and display names match active `opencode` and `opencode-go` Models.dev records.
- Focused tests prevent the corrected lifecycle and model-ID regressions.

## Sources

- https://platform.claude.com/docs/en/about-claude/model-deprecations
- https://platform.claude.com/docs/en/about-claude/models/overview
- https://developers.openai.com/api/docs/models
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/deprecations
- https://docs.mistral.ai/models
- https://models.dev/api.json
