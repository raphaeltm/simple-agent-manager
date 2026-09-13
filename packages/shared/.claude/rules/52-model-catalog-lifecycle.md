# Model Catalog Lifecycle (Adding and Retiring Provider Models)

## When This Applies

Any change that adds, removes, or re-defaults an LLM model ID — new Anthropic/OpenAI
model releases, provider deprecations, or bumping a `DEFAULT_*` model constant.

## Why This Rule Exists

`DEFAULT_SAM_MODEL` pointed at `claude-sonnet-4-20250514` for ~6 weeks after Anthropic
retired it (2026-06-15): every SAM-agent-loop call relying on the default would fail
upstream. Nothing linked default constants to catalog maintenance, and no cadence
existed for pruning retired Anthropic models (one already existed for Cloudflare
models). See `tasks/active/2026-07-25-add-claude-opus-5-model-catalog.md` (moves to
`tasks/archive/` on completion).

## The Two Canonical Lists (edit both, never one)

1. `packages/shared/src/model-catalog.ts` (`CLAUDE_MODELS` et al.) — UI dropdown catalog.
2. `packages/shared/src/constants/ai-services.ts` (`PLATFORM_AI_MODELS`) — AI-proxy
   allowlist (auto-derived) + pricing/tier/scope metadata.

They are hand-maintained and NOT derived from each other. A model only in (1) is
pickable but rejected by the proxy for `providerMode: 'sam'`; a model only in (2) is
usable but undiscoverable. The cross-catalog invariant test in
`packages/shared/tests/model-catalog.test.ts` enforces the (1)→(2) direction.

## Hard Requirements

1. **Verify the model ID against the provider's live docs before adding it.** Never
   construct or guess IDs (no invented date suffixes, no assumed `[1m]` variants).
   For Anthropic: models overview + migration guide at platform.claude.com.
2. **Pricing metadata comes from the provider's published pricing** at add time
   (`costPer1k*` in USD per 1K tokens).
3. **Check the provider's deprecations page in the same PR.** Prune newly retired
   model IDs from `PLATFORM_AI_MODELS`, and append them to the retired-models
   regression test in `packages/shared/tests/unit/ai-model-registry.test.ts` so they
   cannot silently return. Anthropic: /docs/en/about-claude/model-deprecations.
4. **Every cross-file `DEFAULT_*` model constant must reference an ID registered in
   `PLATFORM_AI_MODELS`** (test-enforced: "registers every cross-file default model").
   When adding a new default-model constant anywhere, add it to that test.
5. **Claude Code `[1m]` selector variants** live ONLY in `CLAUDE_MODELS` (never in
   `PLATFORM_AI_MODELS`), and only for models where Claude Code documents the selector.
   Native-1M models (Claude 5 family) are base IDs — see
   `tasks/active/2026-07-01-claude-code-1m-model-selectors.md`.
6. **Do not add unverified third-party-gateway IDs** (e.g. `opencode/…`) for a new
   model — the OpenCode catalog updates dynamically from models.dev; the static
   fallback is refreshed against a checked models.dev snapshot, not by analogy.

## Quick Compliance Check

- [ ] Model ID verified against live provider docs (not memory)
- [ ] Both canonical lists updated; shared model-catalog + ai-model-registry tests updated
- [ ] Provider deprecations page checked; retired IDs pruned + added to the retired test
- [ ] All `DEFAULT_*` model constants point at registered, non-retired IDs
- [ ] Placeholder/example strings in UI reference current models
