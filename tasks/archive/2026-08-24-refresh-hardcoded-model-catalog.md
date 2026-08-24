# Refresh hardcoded model catalog

## Problem

SAM's static agent model catalog is the fallback and validation source for supported coding agents. Provider catalogs and model lifecycle labels change frequently, so every hardcoded agent catalog must be checked against current primary sources and updated only where the sources justify a change.

## Research findings

- Supported agents are defined in `packages/shared/src/agents.ts`: Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp.
- `packages/shared/src/model-catalog.ts` has static model groups for Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, and OpenCode. Amp has no static selector catalog.
- OpenCode normally loads dynamically from `https://models.dev/api.json` through `apps/api/src/services/model-catalog.ts`; the shared OpenCode entries are its outage fallback.
- Anthropic's model overview and deprecation pages still support the current Claude 5 and Claude 4 entries in SAM; the older Claude 4.5 entries are previous active choices rather than a documented retired set.
- OpenAI's model catalog lists the GPT-5.6/5.5/5.4 families and GPT-5.3 Codex as current choices. OpenAI's deprecation table lists GPT-5.2 Codex and the GPT-5.1 Codex family as shut down before this task date, so they should be removed from the active Codex dropdown and platform proxy catalog. `o4-mini` remains listed as deprecated, so it can stay only with a clear deprecated label.
- Google's model page lists Gemini 2.5 Flash-Lite as a current stable Gemini API model. Google's deprecation page no longer supports the existing Gemini 2.5 October 16 retirement label, but it does list Gemini 3.1 Flash-Lite as shutting down on May 7, 2027.
- Mistral's model documentation and Vibe configuration still support SAM's current Mistral API model IDs and configurable `active_model`; no source-backed Mistral ID change is needed in this refresh.
- Live Models.dev data differs from SAM's OpenCode fallback: add `muse-spark-1.2-contributor-free`, `x-preview-f-free`, `opencode-go/deepseek-v4-flash-vision-exp`, `opencode-go/muse-spark-1.2-contributor`, and `opencode-go/ox-alpha-free`; remove inactive `opencode/deepseek-v4-flash-free` and `opencode/laguna-s-2.1-free`; synchronize changed display names for GPT-5.6 Sol, DeepSeek, Hy3, and OpenCode Go labels.

## Implementation checklist

- [x] Reconcile Claude group labels with source-backed lifecycle status.
- [x] Remove retired Codex models from the active dropdown and platform proxy catalog.
- [x] Reconcile OpenAI Codex group names and display labels with current lifecycle evidence.
- [x] Add Gemini 2.5 Flash-Lite and correct Gemini 2.5/Gemini 3.1 lifecycle labels.
- [x] Verify Mistral Vibe entries still match source-supported configurable model IDs.
- [x] Synchronize OpenCode Zen and Go fallback IDs and display names with live Models.dev records.
- [x] Update focused shared-catalog and platform-registry tests for additions, removals, IDs, names, and lifecycle labels.
- [x] Run focused and repository-wide quality checks, specialist reviews, staging verification, CI, merge, and production deployment monitoring.

## Acceptance criteria

- Every hardcoded agent catalog is supported by current authoritative provider evidence.
- Retired models are absent from active dropdown/proxy catalogs; retained retiring or deprecated models are clearly labeled.
- OpenCode outage fallback matches active `opencode` and `opencode-go` Models.dev records and display names at the time of refresh.
- Focused tests detect regression in lifecycle exclusions, current IDs, and source-derived fallback names.
- All required local, staging, CI, merge, and production deployment gates pass.

## Sources

- https://docs.anthropic.com/en/docs/about-claude/models/overview
- https://docs.anthropic.com/en/docs/about-claude/model-deprecations
- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/models/all
- https://developers.openai.com/api/docs/deprecations
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/deprecations
- https://docs.mistral.ai/models
- https://docs.mistral.ai/vibe/code/cli/configuration
- https://docs.mistral.ai/vibe/code/cli/agents
- https://opencode.ai/docs/providers
- https://models.dev/api.json

## Validation evidence

- `pnpm --filter @simple-agent-manager/shared test -- model-catalog` passed: 2 files / 22 tests.
- `pnpm --filter @simple-agent-manager/shared test -- ai-model-registry` passed: 1 file / 37 tests.
- `pnpm --filter @simple-agent-manager/shared typecheck` passed.
- `pnpm --filter @simple-agent-manager/shared lint` passed.
- `pnpm --filter @simple-agent-manager/shared test -- model-catalog ai-model-registry` passed after merging `origin/main`: 3 files / 59 tests.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed.
- Live OpenCode fallback comparison against `https://models.dev/api.json` found zero ID or display-name differences.
- Staging deployment `32713139178` passed for branch SHA `6cbead476e1a7d9f6c010845df4c820d19ebb1b6`.
- Staging API verification against `https://api.sammy.party/api/model-catalog/{agentType}` passed for OpenAI Codex, Google Gemini, and OpenCode changed IDs/labels.
