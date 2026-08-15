# Refresh hardcoded model catalog

## Problem

SAM's static agent model catalog is the fallback and validation source for model selectors. Provider catalogs and lifecycle states change frequently, so every hardcoded agent catalog must be checked against current primary sources and updated only where those sources justify a change.

## Research findings

- Supported agents are defined in `packages/shared/src/agents.ts`: Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp.
- `packages/shared/src/model-catalog.ts` has static groups for every supported agent except Amp, whose managed agent does not expose a SAM model selector.
- The shared catalog feeds `apps/web/src/components/ModelSelect.tsx`, the authenticated API model-catalog route/service, and shared validation. OpenCode normally loads `opencode` and `opencode-go` dynamically through `apps/api/src/services/model-catalog.ts` from `https://models.dev/api.json`; the shared entries are its outage fallback.
- Anthropic's lifecycle source places `claude-opus-4-1-20250805` past its August 5, 2026 retirement date. It must be removed from both canonical Claude lists and pinned in the retired-model regression test.
- OpenAI's current catalog still supports the GPT-5.6/5.5/5.4 frontier families and GPT-5.3 Codex. Older Codex and o4-mini entries now carry explicit deprecated status and must not be presented as current without a lifecycle label.
- Google's current model and deprecation pages support the existing Gemini 3 entries. Gemini 2.5 Pro and Flash remain available but have an October 16, 2026 shutdown date, so retained choices need an explicit retiring label.
- Mistral's current model cards document `mistral-medium-3-5`, `devstral-2512`, `magistral-medium-2509`, and `ministral-{14b,8b,3b}-2512`; several existing static IDs do not match those documented IDs. Devstral 2, Magistral Medium 1.2, and Mistral Medium 3.1 are already deprecated, while Mistral Medium 3.5, Small 4, Large 3, Codestral, and the Ministral 3 family remain useful current choices.
- Live Models.dev data differs from the OpenCode fallback: add `opencode/longcat-2.0-free` and `opencode/ling-3.0-tiny-free`; remove inactive `opencode/claude-opus-4-1`, `opencode/ling-3.0-flash-free`, and `opencode/qwen3.7-plus`; and synchronize three DeepSeek display names.
- The retained catalog-lifecycle rule and prior model-deprecation task require authoritative IDs, pruning retired models from every canonical list, default-to-catalog invariants, focused regression coverage, durable specialist-review tracking, and verification of the final consumer behavior.

## Implementation checklist

- [x] Remove retired Claude Opus 4.1 from the dropdown and platform proxy catalogs and add it to the retired-model regression list.
- [x] Reconcile OpenAI group names and display labels with current lifecycle evidence without removing still-useful callable legacy choices.
- [x] Clearly label retained Gemini 2.5 choices with their documented shutdown date.
- [x] Replace unsupported Mistral IDs, prune deprecated choices, and retain current documented coding/general/efficient models.
- [x] Synchronize OpenCode Zen and Go fallback IDs and display names with live Models.dev records.
- [x] Update focused shared-catalog and platform-registry tests for additions, removals, IDs, names, and lifecycle labels.
- [x] Run focused and repository-wide quality checks, specialist reviews, staging verification, CI, merge, and production deployment monitoring.

## Validation evidence

- Focused shared catalog/registry suite: 3 files, 59 tests passed.
- Shared package typecheck and lint passed (lint warnings are pre-existing and non-blocking).
- Repository gates passed: lint, typecheck, full test suite, and build; the API suite alone covered 507 files and 6,799 tests.
- A live post-change comparison against `https://models.dev/api.json` found zero additions, removals, or display-name differences for both `opencode` and `opencode-go`.
- Task completion validator: PASS for staging before delivery, then final PASS for archival after verifying every implementation item, acceptance criterion, and exact-SHA production gate.
- Constitution validator: PASS; no Principle XI configuration violations were introduced.
- Test engineer: PASS; focused lifecycle, ID, and display-name regressions are sufficient, and vertical-slice coverage is not newly applicable to a pure shared static-data change.
- Staging deployment run `31376144854` passed at branch SHA `d6662d91c`, including its 12 Playwright smoke tests.
- Authenticated staging browser verification passed: token login returned 200, `app.sammy.party/dashboard` loaded, static Claude/OpenAI/Mistral/Gemini catalogs exposed the expected additions/removals/labels, and the cached OpenCode consumer exposed the active source records.
- Pull request [#1786](https://github.com/raphaeltm/simple-agent-manager/pull/1786) passed all required CI checks and was squash-merged as `43e2cd3c43d7a81a10c4d5cad98e19b32eec8dfa`.
- Production deployment run [31379045015](https://github.com/raphaeltm/simple-agent-manager/actions/runs/31379045015) completed successfully on attempt 3 for the exact merge SHA. Attempt 1 stopped before changes at the D1 safety parser, attempt 2 passed D1 integrity checks but hit a transient Cloudflare container-registry upload authorization failure, and attempt 3 passed the safety gate, Worker/container rollout, web deployment, secret configuration, binary uploads, and deployment health checks.

## Acceptance criteria

- Every hardcoded agent catalog is supported by current authoritative provider evidence.
- Retired models are absent from active dropdown/proxy catalogs; retained retiring or deprecated models are clearly labeled.
- Mistral Vibe choices use current documented API IDs rather than inferred model-name variants.
- The OpenCode outage fallback matches active `opencode` and `opencode-go` Models.dev records and display names at the time of refresh.
- Focused tests detect regression in lifecycle exclusions, current IDs, and source-derived fallback names.
- All required local, staging, CI, merge, and production deployment gates pass.

## Sources

- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/about-claude/model-deprecations
- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/models/all
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/deprecations
- https://docs.mistral.ai/models/model-selection-guide
- https://docs.mistral.ai/vibe/code/cli/configuration
- https://opencode.ai/docs/providers
- https://models.dev/api.json
