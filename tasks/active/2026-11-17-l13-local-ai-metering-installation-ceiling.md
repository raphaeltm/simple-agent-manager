# L13: local AI metering, monthly cap, installation ceiling (F2, rest of F26)

Task `01M7M461PPPMWFDCC790ZHG1YQ`, coordinator `01M7JMXS2JRW6QQMB1356ENPM3`, idea
`01M72M9AEB933ZY8269D376DKC` (LANDING PLAN parts 4 and 6). Channel `feature.selfhost-landing`.

## Problem

Landing slice L13 brings local AI metering and the monthly cap from `sam/selfhost-pass-2` to
main. Finding F2 (#2671 M3): with direct upstream on, nothing bounds what approved users spend of
the platform key; each user sets, raises or clears their own monthly cap. F26 (#2642) items not
closed by L12 must be closed here.

## Research findings

- L12 (#2829) already landed most of L13 on main: `hasLocalAiCostMetering`, local pricing into
  `AiTokenBudgetCounter` (`ai_provider_usage.estimated_cost_usd`), `getLocalMonthlyAiCostUsd`, the
  local branch of `checkMonthlyCostCap`, month-end KV retention, and the F26 fixes (bounded settings
  read, dropped unused `enforced`, preserved `include_usage`).
- Remaining branch pieces not on main: per-model usage rows (`ai_model_usage` + counter RPC +
  `/api/usage/ai` breakdown), cap-unavailable validation and UI note.
- Remaining F26 item: the cap predicate was still duplicated (`usage.ts` budget GET re-derived
  `monthlyCostCapUsd > 0` separately from `checkMonthlyCostCap`).
- Malformed stored budget row: `kv.get(key, 'json')` threw on every AI call (rules 41/50).
- `scripts/selfhost/` does not exist on main (L22). celld copies wrangler DO bindings, so this slice
  needs no self-host-only runtime code: everything is gated by `hasLocalAiCostMetering`, which is
  also reachable on Cloudflare when an operator removes the gateway and enables direct upstream.
- Admin settings registry renders integer settings generically in Admin Settings (superadmin only,
  phone usable) and serves them from a per-isolate cache.

## Checklist

- [x] `aiProxy.monthlyCostCeilingUsd` admin setting (integer USD, 0 = none, superadmin only)
- [x] `AiProxyPorts.monthlyCostCeilingUsd`, worker binding in `aiProxyPorts`
- [x] `effectiveMonthlyCostCapUsd`: one cap predicate for gate, budget GET, validation
- [x] Ceiling read only on the no-gateway path; gateway path I/O unchanged (tested)
- [x] Worker `checkAiUsageGate` wrapper always passes the ports (no caller can omit the ceiling)
- [x] `validateBudgetUpdate` refuses a cap above the ceiling and any cap where unpriced
- [x] Tolerant `getUserBudgetSettings` (malformed row -> defaults, logged)
- [x] Per-model rows written in the same DO transaction as the provider row (no extra RPC)
- [x] `getLocalUsageBreakdown` for `/api/usage/ai` without a gateway, per-row parse isolation
- [x] Budget response `monthlyCostCap { available, ceilingUsd, effectiveCapUsd }`; budget UI
- [x] Docs: `reference/configuration.md`
- [x] Tests: package ceiling suite, counter + gate over SQLite, ports, Playwright audit spec

## Acceptance criteria

- [x] A user with no cap is blocked at the ceiling on the no-gateway path
- [x] A user cap above the ceiling is enforced at the ceiling; PUT refuses it
- [x] Gateway installs: same 4 KV reads in the gate, ceiling never read
- [x] Malformed stored budget row does not fail AI calls
- [ ] Staging: budget page + cap unchanged on gateway path; direct-upstream metering + ceiling
      block; SAM-mode chat end to end; settings reset
