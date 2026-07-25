# Add Claude Opus 5 to Model Catalogs + Fix Retired Model Defaults

## Problem

Anthropic released Claude Opus 5 (`claude-opus-5`) on 2026-07-24. SAM's Claude Code
model lists don't offer it, so users can't discover it in any model dropdown and
`providerMode: 'sam'` users are rejected by the AI-proxy allowlist even if they type
the ID manually.

While researching the integration, a live bug was found: `DEFAULT_SAM_MODEL` was
`claude-sonnet-4-20250514`, which Anthropic **retired on 2026-06-15** (requests fail).
Any deployment without a `SAM_MODEL` env override has a broken SAM agent-loop default.

## Research Findings (verified against live Anthropic docs 2026-07-24/25)

- Model ID is `claude-opus-5` — dateless pinned format, no date suffix, confirmed via
  the models overview and the Opus 4.8 → Opus 5 migration guide.
- Pricing $5/$25 per MTok (same as Opus 4.8) → `costPer1kInputTokens: 0.005`,
  `costPer1kOutputTokens: 0.025`. 1M context (native default), 128K max output, same
  tokenizer as Opus 4.8. Deprecations page: Active, retirement "not sooner than
  July 24, 2027".
- Native-1M Claude 5 models are listed as base IDs per the Sonnet 5 precedent in
  `tasks/active/2026-07-01-claude-code-1m-model-selectors.md` — no `claude-opus-5[1m]`
  selector (mirrors `claude-sonnet-5`; negative assertions added).
- Two canonical hand-maintained lists must both change:
  `packages/shared/src/model-catalog.ts` (`CLAUDE_MODELS`, UI dropdowns) and
  `packages/shared/src/constants/ai-services.ts` (`PLATFORM_AI_MODELS`, proxy
  allowlist + pricing). The dropdown→platform invariant test already enforces pairing.
- Deprecations page (fetched 2026-07-25): `claude-sonnet-4-20250514` and
  `claude-opus-4-20250514` are **Retired** (2026-06-15); `claude-sonnet-4-5-20250929`,
  `claude-opus-4-5-20251101` remain Active; `claude-opus-4-1-20250805` deprecated
  (retires 2026-08-05, already labeled in catalog).
- Stale defaults found: `DEFAULT_SAM_MODEL` (retired model), `DEFAULT_AI_PROXY_ANTHROPIC_MODEL`
  (`claude-sonnet-4-6`, a generation behind), `DEFAULT_TRIAL_MODEL_PRODUCTION`
  (`claude-sonnet-4-5`). User directed all defaults be brought current → `claude-sonnet-5`.
- Model-agnostic pass-throughs need no change: vm-agent `ANTHROPIC_MODEL` env injection,
  ai-proxy `claude-` prefix routing, `ModelSelect` (renders the shared catalog), API
  catalog routes (delegate to shared).
- Related open work: `tasks/backlog/2026-07-13-refresh-supported-agent-model-catalog.md`
  covers a broader multi-provider refresh (Codex/Gemini/Mistral/OpenCode). This task
  delivers the Claude slice; the backlog task was annotated accordingly.

## Implementation Checklist

- [x] Add `claude-opus-5` to `CLAUDE_MODELS` → "Claude 5 (Frontier)" group (base ID, no `[1m]`)
- [x] Add `anthropicModel({ id: 'claude-opus-5', ... })` to `PLATFORM_AI_MODELS`
      (premium, 0.005/0.025, 1M context, sam-agent role, anthropic-premium fallback group)
- [x] Remove retired `claude-sonnet-4-20250514` from `PLATFORM_AI_MODELS`
- [x] `DEFAULT_SAM_MODEL` → `claude-sonnet-5` (bug fix: was retired model)
- [x] `DEFAULT_AI_PROXY_ANTHROPIC_MODEL` → `claude-sonnet-5`
- [x] `DEFAULT_TRIAL_MODEL_PRODUCTION` → `claude-sonnet-5`
- [x] Sync env docs: `apps/api/src/env.ts` comments (3), `apps/api/.env.example`
- [x] Refresh model placeholder examples in `AgentSettingsCard.tsx` + `ProjectAgentCard.tsx`
- [x] Update lockstep tests: shared `model-catalog.test.ts` (opus-5 present, 1M label,
      no `[1m]` variant, isKnownModel), api fixtures off the retired ID
- [x] Regression tests (proven discriminating — fail with the retired default restored):
      `ai-model-registry.test.ts` "does not expose Anthropic models retired upstream" +
      "registers every cross-file default model in PLATFORM_AI_MODELS"
- [x] Trial-runner test asserts production default is an active platform-registered model
- [x] Process fix: `.claude/rules/52-model-catalog-lifecycle.md`
- [x] Local gates: shared build+tests (547 ✓), targeted api unit tests (154 ✓), full
      monorepo build ✓, web unit tests, root typecheck, lint
- [ ] PR green (CI incl. SonarCloud + workers-pool tests) and merged
- [ ] Deploy Production monitored to success

## Acceptance Criteria

- `claude-opus-5` selectable in every Claude Code model dropdown and accepted by the
  AI proxy allowlist, with correct pricing metadata for cost dashboards.
- No retired Anthropic model remains in `PLATFORM_AI_MODELS` or any `DEFAULT_*` constant.
- Regression tests fail if a retired ID reappears in the catalog/defaults or if a
  default references a model missing from `PLATFORM_AI_MODELS`.

## Review Findings (local skeptical reviewers, 2026-07-25)

Six local reviewers: constitution-validator, line-by-line scan, removed-behavior +
cross-file tracer, cleanup lenses, conventions, final gap sweep.

- Constitution: PASS (all three bumped defaults keep their env-override paths).
- Line-by-line: clean (pricing units, ID spelling, sibling-field parity verified).
- Cleanup: `specs/031-sam-agent/plan.md` still documented the retired model as the
  current SAM default → **fixed in this branch** (3 references → `claude-sonnet-5`).
- Conventions: rule 52 pointed at `tasks/archive` for a still-active task → **fixed**.
- Cross-file: 4 candidates triaged —
  - Allowlist now 400s stored `claude-sonnet-4-20250514` rows: intended retirement
    semantics (model 404s upstream anyway); no action.
  - Orphaned KV admin default edge: verified NOT live (prod KV default is
    `@cf/google/gemma-4-26b-a4b-it`, read via CF API 2026-07-25). Deferred to
    `tasks/backlog/2026-07-25-admin-ai-proxy-orphaned-default-model.md`.
  - Translate path forwards client `temperature`/`top_p` to models that reject them
    (pre-existing, reachability unchanged by this PR). Deferred to
    `tasks/backlog/2026-07-25-translate-proxy-sampling-params-4-7-plus.md`.
  - `anthropic-version: 2023-06-01` concern: refuted — canonical version header;
    Sonnet 5 native 1M needs no beta header.

## Post-Mortem (retired default model)

- **What broke**: `DEFAULT_SAM_MODEL = 'claude-sonnet-4-20250514'` — Anthropic retired
  the model 2026-06-15; SAM-agent-loop calls using the default would 404 upstream.
- **Root cause**: the default was set when Sonnet 4 was current (spec 031) and never
  revisited; nothing tied `DEFAULT_*` model constants to catalog/lifecycle maintenance.
- **Timeline**: introduced with spec 031; model deprecated 2026-04-14; retired
  2026-06-15; discovered 2026-07-24 during Opus 5 catalog research (~6 weeks latent).
- **Why not caught**: no test linked cross-file default constants to
  `PLATFORM_AI_MODELS`; no retirement-pruning cadence existed for Anthropic models
  (one existed for deprecated Cloudflare models); deployments likely set `SAM_MODEL`
  env, masking the default.
- **Class of bug**: curated model metadata drifting from the provider's actual model
  lifecycle (stale catalog entries, dead defaults).
- **Process fix**: `.claude/rules/52-model-catalog-lifecycle.md` (canonical-list pairing,
  retirement pruning, default-registration invariant) + the two discriminating
  regression tests above so pruning a retired model breaks the build if any default
  still references it.

## Staging Note

Staging deployment/verification explicitly waived by Raphaël for this PR
("Do not deploy to staging", 2026-07-24). Verification = full local gates + CI +
post-merge production deploy monitoring + production spot-check.
