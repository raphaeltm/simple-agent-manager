# Refresh hardcoded model catalog

## Problem

SAM's static model catalog is the fallback and validation source for supported coding agents. Provider catalogs change frequently, so the fallback must be checked against current primary sources and updated only when source evidence justifies a change.

## Research findings

- Supported agents are defined in `packages/shared/src/agents.ts`: Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp.
- Static groups in `packages/shared/src/model-catalog.ts` cover every supported agent except Amp, whose managed agent does not expose a hardcoded model selector.
- The catalog feeds shared validation and web/API model selectors. OpenCode normally loads dynamically from `apps/api/src/services/model-catalog.ts`, using `https://models.dev/api.json`; the shared entries are its outage fallback.
- Anthropic's current overview and lifecycle table still support the existing Claude 5, Claude 4 latest, and clearly labeled legacy entries. Claude Opus 4.1 remains usable but is scheduled to retire on August 5, 2026.
- OpenAI's current model catalog still supports the existing GPT-5.6 frontier family represented in SAM; no newly justified Codex group change was found.
- Google's current model page now lists Gemini 3.6 Flash and Gemini 3.5 Flash-Lite as stable models. Both are absent from SAM's native Gemini CLI group.
- Mistral's current catalog still supports the existing frontier model entries; no newly justified Vibe group change was found.
- The live Models.dev records for SAM's configured `opencode` and `opencode-go` providers changed since the July 27 refresh. Active additions include `opencode/kimi-k3`, `opencode/qwen3.7-plus`, `opencode-go/gpt-5.6-luna`, and `opencode-go/qwen3.8-max`; several display names also changed in the source.

## Implementation checklist

- [x] Add the newly documented stable Gemini CLI models.
- [x] Synchronize OpenCode Zen and Go static fallback IDs and display names with active Models.dev records.
- [x] Update focused catalog tests for representative additions and changed display names.
- [x] Run focused shared-package and repository quality checks.
- [ ] Complete staging verification, PR/CI, merge, and production deploy monitoring.

## Acceptance criteria

- Every hardcoded agent catalog remains supported by a current primary source.
- The Gemini CLI catalog includes the newly stable Gemini 3.6 Flash and Gemini 3.5 Flash-Lite IDs.
- OpenCode fallback IDs and display names match active `opencode` and `opencode-go` Models.dev records.
- Focused tests cover new entries and detect source/fallback drift.
- CI and required deployment verification pass.

## Sources

- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/about-claude/model-deprecations
- https://developers.openai.com/api/docs/models
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/deprecations
- https://docs.mistral.ai/models
- https://models.dev/api.json

## Validation evidence

- Focused shared catalog tests: 2 files, 22 tests passed.
- Repository gates: lint, typecheck, full test suite, and build passed. An initial unrelated infra DNS import hook timeout passed in isolation and on the aggregate rerun.
- Task completion validator: PASS; checks A-F found no implementation or coverage gaps.
- Constitution validator: PASS; no Principle XI configuration violations introduced.
- Test engineer: PASS; new IDs and changed display names have focused regression coverage; vertical-slice testing is not applicable to this pure shared-data change.
