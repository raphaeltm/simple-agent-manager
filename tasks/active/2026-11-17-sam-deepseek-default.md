# SAM assistant DeepSeek default

## Preflight and scope

Classes: external-api-change, cross-component-change, docs-sync-change, business-logic-change (review reconciliation).
User explicitly forbids staging deployment and validation. Open a PR; never claim production changed without deployed evidence.
Existing flow: SamSession /turns → operator/agent.ts runOperatorTurn → resolveSamConfig → PLATFORM_AI_MODELS → operator/model.ts resolveOperatorModel → Mastra OpenAI-compatible Workers AI gateway. operator/context.ts projects persisted history, and Mastra executes operator tools with SQLite receipts. Model change adds no queries or control loops.

## Research

- Wrangler pins GLM 5.3 Flash; shared fallback is Claude Sonnet 5. Align both on the requested DeepSeek model.
- Official Cloudflare model page verified 2026-11-17: exact ID @cf/deepseek-ai/deepseek-v4.1-flash-1017; 1,048,576 tokens; function calling; reasoning none/low/high/max; USD per million input/cached/output 0.30/0.006/1.20. https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/
- GLM 5.3 Flash page confirms planned retirement 2026-11-20. Keep its registry entry until retirement for explicit overrides; do not change other providers' GLM IDs. https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/
- model-catalog.ts contains harness-specific dropdown IDs, no Workers AI catalog. The assistant uses PLATFORM_AI_MODELS directly; no invented harness selector is needed.
- Production GitHub Environment variables: no SAM_MODEL; repository variable lookup: absent. Production Worker settings verified through a narrowly filtered read using exec_with_secrets at 2026-11-17 11:03:29 UTC: SAM_MODEL plain_text is still @cf/zai-org/glm-5.3-flash. Production D1 read at 11:06:19 UTC found no custom OpenAI-compatible endpoint/base model/agent model overrides. No production mutations performed.
- Existing native workerd/Mastra suite covers tool roundtrips, persisted history, replay, interruption and billing with only model HTTP faked. Run it with new default and assert outbound model/options/history.

## Checklist and acceptance

- [x] Align code and deployed configuration defaults; preserve explicit model overrides.
- [x] Register verified metadata, preserve old model-specific options and add new low-effort options.
- [x] Update current environment and assistant documentation.
- [x] Verify new default, tool calls, historical projection, replay and billing locally, plus relevant checks/CI.
- [ ] Review constitution, Cloudflare configuration, docs and completion; open PR and report overrides/deployment limits.

## Validation and deployment evidence

Local results:
- Shared suite: 52 files, 989 tests passed (includes model registry/catalog).
- Real workerd/Mastra native suite: 3 files, 66 tests passed; tool execution/SQLite receipts, history projection and search, grounding, replay/interruption, streamed reasoning and cached billing. Only upstream HTTP is stubbed; no live provider success claimed.
- Focused API unit suite: 3 files, 56 tests passed. Anthropic-specific fixtures now explicitly select Claude after default change.
- Deployment generation/workflow contracts: 2 files, 120 tests passed, including intentional default retune versus immutable audit baseline.
- Shared build/lint, API typecheck, changed API/quality ESLint, instruction context budget: passed.
- Initial native run exposed test-only shared env override leakage; setup now clears SAM_MODEL to use code default. Initial unit/deploy failures corrected as above.
- Redundant Wrangler SAM_MODEL removed; fallback recorded in OMITTED_WORKER_VAR_DEFAULTS and probed through resolveSamConfig. Both workflow sync steps forward an explicit SAM_MODEL through the existing logged optional override path. Normal deployment removes the old binding without keep-vars. No migrations, new infrastructure, auth changes, new settings or dependencies.
- Local specialist review confirmed Cloudflare, constitution and doc-sync PASS; task completion findings ADDRESSED after green reruns. PR/CI pending.
- Staging explicitly skipped by user; no deploy or validation. Production still old model; needs normal reviewed release and post-deploy binding + health verification.

## PR follow-up

PR https://github.com/raphaeltm/simple-agent-manager/pull/2860. Codex GitHub review reported no findings; CodeRabbit request succeeded but review was rate-limited, so no re-trigger. Initial smoke, secret scan and benchmarks passed.
PR Evidence description corrected to use full paths and explicit official-documentation wording; local event-payload preflight passes. Sonar flagged 2 changed lines in pre-existing duplicated Anthropic fixture blocks (3.6% new-line duplication). Hoisted read-only Claude test configuration to suite scope; focused suite 39/39 and ESLint pass, local reviewer confirms unchanged behavior and no config mutation. New head CI must pass before merge. Staging remains forbidden; no production changes.

## Scope and binding review reconciliation

Codex review comments 4598890169 and 4598890182 addressed. Catalog hierarchy scopes remain unchanged; explicit account assistant SAM_MODEL now checks the existing good reliability floor plus Chat Completions tool support. Configured custom endpoint owns its capabilities instead of its catalog billing entry. No fabricated excellent rating. Model guard is centralized in operator/model.ts; pure controls cover default, limited, none, false Chat Completions support and custom override, plus real native positive/negative paths.

Redundant binding removed, documented as omitted code default, both deploy sync mappings forward SAM_MODEL, and tests prove override and absence. Local results: full native 67/67, deploy contracts 122/122, contract+omitted defaults 10/10; native default/limited targeted check 2 pass and 24 intentionally filtered. API typecheck/lint and context budget passed. Final five-skill local review PASS. PR Evidence and Sonar passed on prior head after original fixes; fresh head CI pending. No staging or production mutations.

Final doc review: corrected the remaining current-default statement in the public recent-product-changes self-hoster notes, linking the canonical assistant configuration (Codex finding 4598972296). Historical feature rollout dates preserved.
