# Hosted SAM AI spending limits: admin ceiling on the gateway path, close the hour-long overspend

Task 01M8BMCD0B9HPZKMJ3VD1WN62Y. Idea 01M89FVN8N54G0676JXHZW2JQY. Decision: Raphaël, 2026-11-26
(ask:01M89KSK5FSSEH923XYSS8A3BQ): "Fix both: apply the admin limit on hosted, and stop the
up-to-an-hour overspend". Affects hosted SAM and every install with Cloudflare AI Gateway. The
self-host box path (no gateway) must not change behaviour.

## Problem

1. `checkMonthlyCostCap` (`packages/ai-proxy/src/ai-monthly-cost-cap.ts`) applies the admin ceiling
   `aiProxy.perUserMonthlyCostCeilingUsd` only when there is no gateway.
   `resolveMonthlyCostCeilingUsd()` returns null early on gateway installs, so the gate, the usage
   page (`apps/api/src/routes/usage.ts`) and the cap-update validation all ignore it.
2. With a gateway, spend comes only from the hourly cron (`runMonthlyCostAggregation`, cron
   `30 * * * *`) into KV `ai-monthly-cost:{user}:{YYYY-MM}`. Missing KV means allowed; a present
   value can be up to an hour stale.

## Research findings

- Pricing already exists and is shared: `incrementExtractedUsage()`
  (`ai-token-usage-accounting.ts`) prices with `findPricedModel()`/`priceModelUsageUsd()`
  (`ai-cost-pricing.ts`, `PLATFORM_AI_MODELS`), but only when `hasLocalAiCostMetering(env)`.
  Callers already pass `costModelId` only for platform-routed calls (passthrough:
  `platformCostModelId()`; `/ai/v1`: not custom endpoints; SAM agent loop: not endpoint calls).
- The estimate must NOT be written into `ai_provider_usage.estimated_cost_usd` on gateway installs:
  `GET /api/usage/ai` adds local provider rows to gateway totals for direct passthrough, so pricing
  gateway-routed calls there would double count the usage page. A separate estimate table in the
  same `AiTokenBudgetCounter` DO is needed (reuse the DO, not the display table).
- The pre-call gate already makes one DO RPC to the same per-user counter
  (`checkTokenBudget` → `getTokenUsage` → `counter.get`); if the DO throws, the call already fails.
  Post-response accounting already makes `increment` + `incrementProviderUsage` RPCs.
- Measurement (production gateway `sam`, Nov 1-26, 1,531 logs; staging `sam`/`sam2`, 701 logs),
  repricing each log with the catalog (gateway logs carry no cache split, so cached-heavy calls look
  overpriced and Anthropic cache reads/writes are missing from `tokens_in`):
  - Workers AI gemma-4-26b: estimate/gateway 1.00 (prod 1,187 calls, staging 260).
  - deepseek-v4.1-flash: 1.66-1.86 from the log repricing, explained by cached input (catalog has a
    cached rate; logs do not split cache). Spot checks match within ~5% once cache is assumed.
  - gpt-5.4-mini 1.19 (1 call), gpt-5.6-luna 4.02 (2 calls): catalog list price for luna is 4x what
    the gateway charged. Over-pricing exists.
  - claude-sonnet-5 0.15: logs omit cache tokens; the local path adds them, so not comparable.
  - Biggest production spend (glm-5.2 $3.45, clef-omni) has no catalog price: estimate $0 there; and
    95% of production gateway dollars carry no `metadata.userId`, so the cron attributes nothing to
    any user for them (separate finding, out of scope, filed below).
  - Conclusion: the estimate can be off by up to ~4x for some models. A whole-month
    `max(gateway, estimate)` would refuse a luna-heavy user at ~25% of their cap. The estimate must
    only cover the window the gateway total has not seen yet.

## Design (Phase 1, sent to coordinator)

1. **Admin ceiling everywhere.** Remove the gateway early-return in
   `resolveMonthlyCostCeilingUsd()`; the gateway branch uses
   `effectiveMonthlyCostCapUsd(userCap, ceiling)` and reports `limitSource: 'administrator'`. The
   usage page and cap validation already call the same resolver. The ceiling applies to
   platform-billed calls only (box semantics): BYO passthrough (`platformBilled === false`) keeps
   today's gateway behaviour (user cap vs gateway total) and is not refused by the ceiling.
   Settings description and docs updated. Unreadable settings → 503 (as on the box).
2. **Estimate backstop, windowed, gateway authoritative.**
   - Post-response: price with the same code on every install; on gateway installs write the cost to
     a new `ai_cost_estimate` table (10-minute buckets + one month row) inside the existing
     `incrementProviderUsage` transaction (no extra RPC). Box path unchanged.
   - Cron writes `{costUsd, asOf}` JSON (asOf = run start); reader accepts legacy plain numbers.
   - Spend = `gatewayTotal + estimate(since asOf − lag margin)`; KV missing → month estimate.
     Disjoint windows, so no double counting except the lag margin (deliberately conservative,
     default 10 min, configurable). Catalog error only affects the last ≤ ~80 minutes.
   - Reconciliation: each cron run moves `asOf` forward; estimate buckets before it drop out of the
     sum and the gateway's own number replaces them.
3. **Failure behaviour.** The new reads ride the existing pre-call DO RPC (daily budget). A DO
   failure already fails the call today (getTokenUsage throws); blast radius unchanged: that one
   user's calls, while their DO is unreachable. KV read failure → use estimate since month start.
4. **Concurrency (rules 45/69).** The DO read is atomic per user; there is no reservation. Overshoot
   is bounded by the cost of calls already in flight when the cap is crossed (each admitted call can
   overshoot by its own cost), the same contract the box documents today. Hard reservation would
   need a per-call max-cost hold and is a product decision (offered, not built).
5. **I/O.** Pre-call: 0 extra round-trips (fold into the existing counter RPC) + 1 KV read
   (existing). Post-response: 0 extra (same `incrementProviderUsage` transaction). Gateway installs
   additionally read the ceiling from the cached admin settings snapshot (per-isolate cache).
6. **Cost (rule 76).** No Cloudflare cost claim made; DO row writes per call +1–2 rows in an
   existing transaction.

## Checklist

- [x] Coordinator go on design (approved 2026-11-26, including the windowed deviation)
- [x] Classify unattributed gateway traffic (coordinator ask): all SAM-internal (platform-feedback-triage, task-title, project-brief); no attribution bug; documented in configuration.md
- [x] Ceiling on gateway path (`resolveMonthlyCostCeilingUsd`, `checkGatewayCostAdmission`)
- [x] Estimate storage in `AiTokenBudgetCounter` (bucket + month tables, pruning)
- [x] Pricing on gateway path writes the estimate, not display rows (proxy accounting + SAM operator)
- [x] Combined admission read RPC (`getGatewayAdmissionSnapshot` replaces the daily `get`)
- [x] Cron writes `{costUsd, asOfMs}`; reader parses both formats
- [x] Config: lag margin as admin setting `aiProxy.costEstimateGatewayLagSeconds` (runtime-tunables rule)
- [x] Setting descriptions + `reference/configuration.md` (web UI reads ceilingUsd from the API; no copy change needed)
- [x] Tests, each guard deleted once to show red (results below)
- [ ] Staging verification with a sam-mode user, < $0.50 spend
- [x] Backlog task: luna price (`tasks/backlog/2026-11-26-gpt-5-6-luna-catalog-price.md`)

## Guard-deletion evidence

`.tmp/mutate.py` deleted each guard and ran the two DO test files:

| Guard removed | Tests that went red |
| --- | --- |
| G1 ceiling on gateway path | refuses at the ceiling…, applies to a user who never set a cap…, reads the ceiling… one counter RPC |
| G2 month estimate when no KV total | refuses on the month estimate…, concurrent responses…, KV unreadable…, malformed total… |
| G3 estimate since asOf | stale total…, lag margin…, legacy total… |
| G4 sum with month estimate (instead of window) | gateway total alone over cap…, does not count calls the gateway total includes…, lag margin… |
| G4b max(gateway, month) | stale total…, does not count calls…, lag margin…, legacy total… |
| G5 lag margin | keeps counting calls inside the lag margin |
| G6 display cost 0 on gateway | leaves provider rows unpriced… |
| G7 operator display | routes the SAM operator price to the backstop… |
| G8 bucket prune | prunes buckets past retention… |
| G9 estimate written in increment txn | 10 estimate tests |
| G10 legacy asOf age | reads a legacy plain-number total… |

The DO-failure path (snapshot RPC throws → gate throws) is asserted directly; the box path is covered unchanged by `ai-token-budget-counter-model-usage.test.ts`, `ai-test-upstream-ceiling.test.ts` (workers runtime) and the package tests.

## Acceptance criteria

- Gateway env, admin ceiling below user cap → refused at ceiling with administrator message.
- KV missing, estimate ≥ cap → refused.
- KV stale below cap, KV + recent estimate ≥ cap → refused.
- Estimate below, KV ≥ cap → refused.
- Box path behaviour unchanged (existing tests green).
- Staging: refusal immediately after crossing a few-cent cap, and ceiling refusal.
