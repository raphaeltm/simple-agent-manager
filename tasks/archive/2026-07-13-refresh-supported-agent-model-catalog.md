# Refresh Supported Agent Model Catalog

## Problem

SAM's shared static agent model catalog has drifted from current provider and agent sources. Several entries use invalid or retired IDs, lifecycle labels are stale, the Codex GPT-5.6 entries are still marked preview after becoming recommended models, and the OpenCode static fallback no longer matches the active Models.dev catalog. These stale suggestions can make model selection fail or hide supported choices.

## Research Findings

- `packages/shared/src/agents.ts` defines six supported agent types: Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp. Amp has no hardcoded model group; the other five do.
- `packages/shared/src/model-catalog.ts` is consumed directly by `apps/web/src/components/ModelSelect.tsx`, by the authenticated model-catalog API fallback in `apps/api/src/services/model-catalog.ts`, and by shared tests. OpenCode normally loads dynamically from Models.dev but falls back to this static catalog.
- Claude's current overview lists Fable 5, Opus 4.8, Sonnet 5, and Haiku 4.5 as current models. Anthropic's lifecycle table says `claude-sonnet-4-20250514` is retired and `claude-opus-4-1-20250805` is deprecated with retirement on August 5, 2026.
- Codex's official model page now recommends GPT-5.6 Sol, Terra, Luna, GPT-5.5, and GPT-5.3 Codex Spark; GPT-5.6 is no longer presented as preview. Spark is a ChatGPT Pro research preview, so it must be clearly labeled and treated as a Codex-only selection rather than a platform AI proxy model. The page says GPT-5.2 and GPT-5.3 Codex are deprecated for ChatGPT sign-in.
- Gemini CLI documents the exact `gemini-3.1-pro-preview` selector. Google's current model lifecycle table lists `gemini-3.5-flash`, `gemini-3.1-pro-preview`, and `gemini-3.1-flash-lite` as supported; Gemini 2.5 remains available until October 16, 2026; Gemini 2.0 was shut down June 1, 2026.
- Mistral's official model cards show several static IDs are malformed: `devstral-2512`, `magistral-medium-2509`, and `ministral-{14b,8b,3b}-2512` are the documented IDs. Devstral 2, Magistral Medium 1.2, and Mistral Medium 3.1 are legacy/deprecated; Codestral 2508 remains documented and available.
- The configured Models.dev source (`https://models.dev/api.json`) currently contains 55 active OpenCode Zen entries and 13 active OpenCode Go entries after excluding `status: deprecated`. The static fallback contains both missing active entries and entries Models.dev now marks deprecated.
- Prior maintenance records establish two important contracts: every platform-routed Claude/Codex suggestion must exist in `PLATFORM_AI_MODELS`, while Claude Code selector suffixes and credential-restricted agent-native selections need explicit test exceptions; OpenCode dynamic normalization excludes deprecated entries and preserves provider-qualified IDs.
- No relevant retained post-mortem was found for this data-only catalog refresh. The closest archived tasks are the API allowlist synchronization and dynamic OpenCode fallback work referenced below.

## Implementation Checklist

- [x] Refresh Claude Code groups: keep current models/selectors, remove retired Sonnet 4, and clearly label deprecated Opus 4.1.
- [x] Refresh Codex groups and display names from the Codex model page, including a clearly scoped GPT-5.3 Codex Spark preview entry and removal of stale GPT-5.6 preview labels.
- [x] Refresh Gemini CLI IDs and lifecycle groups: correct Gemini 3.1 Pro Preview, add supported Flash Lite choices where justified, and remove retired Gemini 2.0.
- [x] Correct Mistral API IDs and reorganize current versus legacy/deprecated Vibe choices without removing still-useful documented models.
- [x] Synchronize the OpenCode static fallback with active `opencode` and `opencode-go` Models.dev entries, preserving provider-qualified IDs and source display names.
- [x] Update focused shared tests to assert exact critical IDs, lifecycle removals, provider-qualified OpenCode coverage, no duplicate IDs, and platform-proxy versus agent-only selection invariants.
- [x] Confirm no API route/service or UI contract shape changed; existing consumers continue to receive `ModelGroup[]`.
- [x] Run focused shared/API/web checks and the repository quality suite required by `/do`.
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
