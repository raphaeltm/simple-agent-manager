# Refresh hardcoded model catalog

## Problem

SAM's static model catalog is the fallback and validation source for supported coding agents. Provider catalogs change frequently, so the fallback must be checked against current primary sources and updated only when source evidence justifies a change.

## Research findings

- Supported agents are defined in `packages/shared/src/agents.ts`: Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp.
- Static groups in `packages/shared/src/model-catalog.ts` cover every supported agent except Amp, whose managed agent does not expose a hardcoded model selector.
- The catalog feeds shared validation and web/API model selectors. OpenCode normally loads dynamically from `apps/api/src/services/model-catalog.ts`, using `https://models.dev/api.json`; the shared entries are its outage fallback.
- Anthropic's current model overview confirms Claude Fable 5, Opus 5, Sonnet 5, and Haiku 4.5 as the current family. Existing Claude entries already reflect that source and its legacy lifecycle.
- OpenAI's current model catalog confirms the GPT-5.6 Sol/Terra/Luna, GPT-5.5, and GPT-5.4 families already represented in SAM.
- Google's current model and deprecation pages confirm the Gemini 3.5 Flash, Gemini 3.1 Pro Preview, Gemini 3.1 Flash-Lite, and retained Gemini 2.5 choices already represented in the Gemini CLI group.
- Mistral's current model catalog confirms the existing Mistral Medium 3.5, Small 4, Large 3, Devstral 2, Codestral, Magistral, and Ministral entries.
- The live Models.dev records for SAM's configured `opencode` and `opencode-go` providers have changed since the prior fallback refresh. Active additions are `opencode/claude-opus-5`, `opencode/gemini-3.5-flash-lite`, `opencode/gemini-3.6-flash`, `opencode/laguna-s-2.1-free`, `opencode/ling-3.0-flash-free`, and `opencode-go/hy3`. The prior `opencode/hy3-free` record is no longer active.

## Implementation checklist

- [x] Synchronize the OpenCode Zen and Go static fallback groups with active Models.dev records and display names.
- [x] Update focused model-catalog tests for representative additions and the removed inactive ID.
- [x] Run focused shared-package and repository quality checks.
- [x] Complete specialist review and staging verification.
- [ ] Complete PR/CI, merge, and production deploy monitoring.

## Acceptance criteria

- Every hardcoded agent catalog remains supported by a current primary source.
- OpenCode fallback IDs and display names match active `opencode` and `opencode-go` Models.dev records.
- Focused tests cover new representative entries and prevent the inactive `opencode/hy3-free` ID from returning.
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

- Focused shared catalog tests: 2 files, 21 tests passed.
- Repository gates: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed.
- Specialist reviews: task completion, constitution, and test quality all passed without findings.
- Staging deployment: [Deploy Staging run 30253600731](https://github.com/raphaeltm/simple-agent-manager/actions/runs/30253600731) passed, including deployment health checks and CI smoke tests.
- Independent authenticated Playwright smoke suite: 11 passed, 1 passed on retry after an initial `networkidle` timeout; dashboard, projects, settings, API tokens, authentication redirect, API health/CORS, and Amp catalog exposure were verified.
- Observability-noise gate completed with no significant noise detected; D1 and Workers telemetry subqueries were unavailable in this environment and reported as skipped.
- Infrastructure-specific verification is not applicable because no infrastructure paths changed.
- Mobile/desktop visual verification is not applicable because no UI paths changed.
