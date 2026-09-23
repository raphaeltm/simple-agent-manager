# Refresh Supported Agent Model Catalog

> **Scope update (2026-07-25):** the Claude Code slice shipped separately in
> `tasks/active/2026-07-25-add-claude-opus-5-model-catalog.md` — Claude Opus 5 added,
> retired Sonnet 4 pruned from `PLATFORM_AI_MODELS`, defaults bumped to
> `claude-sonnet-5`, and retirement/default regression tests added (see
> `.claude/rules/52-model-catalog-lifecycle.md`). Remaining scope here: Codex,
> Gemini, Mistral Vibe, and the OpenCode static fallback sync.

## Problem

SAM's shared static agent model catalog has drifted from current provider and agent sources. Several entries use invalid or retired IDs, lifecycle labels are stale, the Codex GPT-5.6 entries are still marked preview after becoming recommended models, and the OpenCode static fallback no longer matches the active Models.dev catalog. These stale suggestions can make model selection fail or hide supported choices.

## Research Findings

- `packages/shared/src/agents.ts` defines six supported agent types: Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp. Amp has no hardcoded model group; the other five do.
- `packages/shared/src/model-catalog.ts` is consumed directly by `apps/web/src/components/ModelSelect.tsx`, by the authenticated model-catalog API fallback in `apps/api/src/services/model-catalog.ts`, and by shared tests. OpenCode normally loads dynamically from Models.dev but falls back to this static catalog.
- Claude's current overview and Claude Code model configuration support the existing Fable 5, Opus 5, Sonnet 5, Opus 4.8/4.7/4.6, Sonnet 4.6, Haiku 4.5, and 1M selector entries. Retired raw Sonnet 4 and Opus 4.1 IDs are not present in the current static Claude Code catalog, so no Claude Code catalog changes were needed in this run.
- Codex's official model page now recommends GPT-5.6 Sol, Terra, and Luna; GPT-5.6 is no longer presented as preview. The page says GPT-5.4 and GPT-5.4 Mini retire from Codex with ChatGPT sign-in on August 31, 2026, and GPT-5.2 plus GPT-5.3 Codex are already deprecated for ChatGPT sign-in. GPT-5.3 Codex Spark appears on the Codex page as a ChatGPT Pro research preview, but the OpenAI API all-models page does not list it, so this run did not add it to SAM's platform-routed Codex dropdown.
- Google's current Gemini model table lists `gemini-3.7-flash` as the latest stable Gemini 3 Flash model. Existing `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview`, and `gemini-3.1-flash-lite` remain supported; Gemini 2.5 remains available until October 16, 2026; Gemini 2.0 was shut down June 1, 2026.
- Mistral's current model overview lists the existing SAM Vibe choices, including Mistral Medium 3.5, Mistral Small 4, Mistral Large 3, Ministral 3, and Codestral v25.08. The current static Mistral Vibe catalog already matched those documented IDs, so no Mistral Vibe catalog changes were needed in this run.
- The configured Models.dev source (`https://models.dev/api.json`) currently contains 62 active OpenCode Zen entries and 19 active OpenCode Go entries after excluding `status: deprecated`. The static fallback was missing six active entries (`opencode/gemini-3.7-flash`, `opencode/grok-4.6`, `opencode/hy3-free`, `opencode/muse-spark-1.2`, `opencode/nemotron-3.5-lightning-free`, `opencode-go/glm-5.3`) and still included three inactive entries (`opencode/ling-3.0-tiny-free`, `opencode/longcat-2.0-free`, `opencode/north-mini-code-free`).
- Prior maintenance records establish two important contracts: every platform-routed Claude/Codex suggestion must exist in `PLATFORM_AI_MODELS`, while Claude Code selector suffixes and credential-restricted agent-native selections need explicit test exceptions; OpenCode dynamic normalization excludes deprecated entries and preserves provider-qualified IDs.
- No relevant retained post-mortem was found for this data-only catalog refresh. The closest archived tasks are the API allowlist synchronization and dynamic OpenCode fallback work referenced below.

## Implementation Checklist

- [x] Refresh Claude Code groups: keep current models/selectors, remove retired Sonnet 4, and clearly label deprecated Opus 4.1. No Claude Code catalog changes were needed in this run.
- [x] Refresh Codex groups and display names from the Codex model page: remove stale GPT-5.6 preview labels, label GPT-5.4/GPT-5.4 Mini as retiring August 31, 2026, and move GPT-5.3 Codex into a deprecated Codex group. GPT-5.3 Codex Spark was intentionally not added because the API model catalog does not list it.
- [x] Refresh Gemini CLI IDs and lifecycle groups: add `gemini-3.7-flash`; existing Gemini 3 and retiring Gemini 2.5 entries remain source-supported.
- [x] Correct Mistral API IDs and reorganize current versus legacy/deprecated Vibe choices without removing still-useful documented models. No Mistral Vibe catalog changes were needed in this run.
- [x] Synchronize the OpenCode static fallback with active `opencode` and `opencode-go` Models.dev entries, preserving provider-qualified IDs and source display names.
- [x] Update focused shared tests to assert exact critical IDs, lifecycle removals, provider-qualified OpenCode coverage, no duplicate IDs, and platform-proxy versus agent-only selection invariants.
- [x] Update any affected API route/service or UI contract tests if catalog grouping or agent-only exceptions require it. No API route or UI contract changes were required.
- [x] Run focused shared/API/web checks and the repository quality suite required by `/do`: focused shared catalog tests, shared lint/typecheck/full tests, OpenCode live snapshot comparison, `pnpm check:fast`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed.
- [ ] Complete task validation and specialist review, deploy/verify staging, open the PR, wait for green CI, merge, and monitor production deployment.

## Acceptance Criteria

- Every hardcoded agent group is justified by a current primary source, and Amp remains intentionally catalog-free.
- No retired Claude Sonnet 4 or Gemini 2.0 model is suggested.
- Deprecated/legacy models that remain are visibly labeled with their lifecycle status.
- Codex GPT-5.6 names no longer claim preview status, and restricted Codex-native models cannot accidentally be treated as raw platform proxy IDs.
- Mistral model IDs exactly match the official model cards and current overview.
- The OpenCode fallback contains the same active IDs and names as the checked Models.dev `opencode` and `opencode-go` snapshot, excluding deprecated entries.
- Focused tests cover the updated catalog and all touched contracts; lint, typecheck, tests, and build pass.
- The PR is green, merged, and the production deployment succeeds.

## PR and Staging Evidence

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1843
- Staging deploy: https://github.com/raphaeltm/simple-agent-manager/actions/runs/32016010091
- Staging result: deploy, health check, and GitHub Playwright smoke tests passed; smoke-tests reported 12 passed.
- Targeted staging catalog verification: authenticated API checks passed for Codex GPT-5.6 display labels, Codex GPT-5.4 retirement labels, Codex deprecated labels, Gemini 3.7 presence, OpenCode Gemini 3.7 presence, and removal of inactive OpenCode Ling tiny.

## References

- Anthropic models overview: https://platform.claude.com/docs/en/about-claude/models/overview
- Anthropic model deprecations: https://platform.claude.com/docs/en/about-claude/model-deprecations
- Codex models: https://learn.chatgpt.com/docs/models
- OpenAI API models: https://developers.openai.com/api/docs/models
- Gemini CLI model selection: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model.md
- Gemini 3 CLI guide: https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/gemini-3.md
- Gemini API deprecations: https://ai.google.dev/gemini-api/docs/deprecations
- Mistral model overview: https://docs.mistral.ai/models/overview
- Mistral Vibe source defaults: https://github.com/mistralai/mistral-vibe/blob/main/vibe/core/config/_settings.py
- Models.dev catalog: https://models.dev/api.json
- Prior API catalog synchronization: `tasks/archive/2026-05-20-sync-model-catalog-api-offerings.md`
- Prior dynamic OpenCode catalog work: `tasks/archive/2026-06-27-dynamic-opencode-model-catalog.md`
- Claude Code 1M selector contract: `tasks/active/2026-07-01-claude-code-1m-model-selectors.md`
