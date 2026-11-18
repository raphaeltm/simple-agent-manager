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

- [x] `aiProxy.perUserMonthlyCostCeilingUsd` admin setting (integer USD, 0 = none, superadmin only)
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
- [x] Takeover: verify/fix platform passthrough pricing, missing output, own-funding scope and ceiling recovery advice
- [x] Staging2: gateway budget/cap unchanged; superadmin ceiling edit and ordinary user refused; ceiling inert with gateway; SAM-mode chat; settings/resources reset
## Accepted follow-up

Live no-gateway metering/ceiling proof is owed to the self-host box with L22 (explicit coordinator acceptance channel165; unreachable on Cloudflare staging). It is outside this PR’s accepted staging gate; it is not claimed complete.


## Takeover completion evidence

Takeover task `01M7NBJWNJMHYZ8RY30M54PZP6` continues the same branch and PR #2839.
The initial normal main merge included #2841. The final sync includes main b7502ba96
(#2859 L17b reverse-tunnel gateway, following #2838 Insights and #2876 Claude Action).
The L13 feature patch before/after each main sync is byte-for-byte identical; the late P1/P2
corrections below are additional locally tested no-gateway changes relative to the staged head.
Bounded carryover reviews found no change to Gateway budgets, ceiling settings or credential
selection. L17b's shared node routing preserves the Cloudflare container route and imports no
self-host implementation into the Worker. Focused container/transport checks and fresh CI cover
the merged wiring. This carries staged L13 behavior evidence; it does not claim an exact-head deploy.

- Full staged-head CI 44193579523 succeeded; E2E, CodSpeed and Sonar passed. All 10 automated
  findings are resolved. Original security, UI, performance and completion findings are ADDRESSED;
  takeover security, Cloudflare and UI delta reviews passed.
- Normal staging2 reservation 44150628260 honored the queue. Deployment 44206822502 succeeded,
  including container rollout and smoke tests. The superadmin saved/read back ceiling $1; an
  ordinary user received 403 without a revision change. Gateway metadata reported no ceiling and
  accepted a $100 personal cap.
- The actual SAM-funded Claude chat returned its nonce while Gateway spend $1.371899 exceeded
  the installation ceiling. The account had no personal legacy/composable credentials; read-only
  runtime records showed sam-proxy/platform/Anthropic. The earlier personal-OAuth admin chat is
  excluded from this proof.
- Changing only the personal cap from $100 to $0.01 produced 15 fresh AI POST 429 responses with
  no upstream forwarding at 01:07:32–01:08:51 UTC. KV confirmed spend $1.371899 and cap $0.01;
  daily usage (35 input/473 output tokens) and request rate were below their limits. Independent
  security review accepted backend monthly-cap enforcement. CLI retries hide the response body;
  transcript silence is not the proof. The earlier upstream 402 is excluded.
- Budget and actual SAM chat screenshots at 375px/1280px were opened, reviewed and uploaded:
  [PR evidence comment](https://github.com/raphaeltm/simple-agent-manager/pull/2839#issuecomment-6965962528).
- All three test workspaces are absent from D1; both temporary projects/profiles were deleted.
  Both users' budgets and agent preferences, plus the installation ceiling, were restored and
  read back. Both auth sessions were invalidated. Temporary CF tails closed; no KV write succeeded.
  Normal release 44214048795 succeeded; authoritative 01:19 UTC status showed no holder and L15 on its turn. L15 was notified.

Final task-completion review passed before archive: research, implementation, tests/live acceptance, UI propagation, funding/runtime variants, vertical slice coverage and cleanup/restoration/release. No outstanding findings remain in the accepted L13 scope. Exact-head CI and normal serial merge remain release gates.
The coordinator lifted the #2841 production hold in event
`be50db76-357a-4f17-8d19-46f82048d6ec` and monitors production after merge.

## Late review corrections (2026-11-18)
- Codex P1: a failed installation-ceiling read now raises a sanitized retryable 503 before
  platform-funded inference. The worker uses the strict settings snapshot (at most 60 s cache);
  removed its extra last-known fallback so an old disabled/higher ceiling cannot outlive that
  cache during an outage. Gateway and locally own-funded calls never read the ceiling.
- Codex P2: OpenAI legacy message.function_call and split streamed delta.function_call
  name/arguments count toward estimated output when provider usage is absent.
- Discrimination: ceiling-fault test returned null before the fix (RED); both legacy-function
  JSON/SSE tests recorded $0 before the fix (RED). Full package suite now 187 PASS. Worker
  port/real-SQLite/passthrough suites 73 PASS. Package lint/typecheck and secret guard PASS.
- Independent security/completion delta review PASS: inference cannot proceed with unknown
  ceiling state. These changes affect only no-gateway local metering; prior accepted Gateway
  staging evidence carries unchanged. Fault-path live proof is also owed to self-host L22.

## Complete request fallback and ceiling validation follow-up
- Missing-usage input estimates now cover the full serialized request (system prompts, tool
  schemas, structured history and names) for locally metered platform-funded passthrough calls.
  Four JSON/SSE regressions across Anthropic/OpenAI went RED with zero input before the fix and
  GREEN afterward; Gateway/user/project-funded controls retain their prior estimate and measured
  usage retains precedence.
- Removed the arbitrary $1M ceiling validation maximum. Admin remains the business limit; only
  nonnegative safe-integer whole USD is required for exact numeric representation. Two cases
  above the old maximum went RED before the fix; all seven validation cases now pass.
- Combined Worker settings/ports/real-SQLite/passthrough tests: 88 PASS; package187 PASS. The
  configuration reference describes both behaviors; all53pages have zero broken internal links.
- The fixes affect no-gateway local metering/validation. Accepted Gateway staging evidence
  carries unchanged; self-host missing-usage/ceiling live proof remains owed to L22.

## Spending-store outage response follow-up
A failed local monthly-spend lookup now raises a sanitized retryable 503 before inference,
instead of fabricating a reached-cap429 with zero cost. DO and KV failure regressions through
the real admission gate both went RED before the fix; package189 and combinedWorker88 pass.
Independent security/completion review PASS (30ceiling cases). Retry text is generic to both
settings and spending-data outages. Fullbuild19, lint/typecheck, secret guard and doclinks pass.
The final main sync also includes88b6103e1 (#2879), an unrelated task archive only; runtime
changes remain those reviewed above. Gateway staging proof carries; L22 still owes live self-host
coverage for no-gateway metering and fault paths.
