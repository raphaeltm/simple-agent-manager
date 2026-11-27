# Monthly AI cap and admin ceiling are not enforced on a gateway install without the account API

## Problem

`checkGatewayCostAdmission` (`packages/ai-proxy/src/ai-monthly-cost-cap.ts`) allows every call when
`isMonthlyCostCapAvailable(env)` is false: an addressable AI Gateway (`AI_GATEWAY_ID` + `CF_ACCOUNT_ID`)
with no `CF_API_TOKEN`. The hourly cron cannot read gateway logs there, so the cap was reported
unavailable. Since the hosted spending-limit fix, SAM keeps a catalog-priced month estimate in the
per-user counter on gateway installs, so the admin ceiling could be enforced on that estimate.

## Context

Security review of the hosted spending-limit PR (MEDIUM, deferred). Hosted SAM and the documented
Cloudflare deploy always set `CF_API_TOKEN`, so no known installation is in this state. Changing it
also changes user-facing semantics: the usage page reports the cap as unavailable there and
`PUT /api/usage/ai/budget` refuses a user cap (`MONTHLY_COST_CAP_UNAVAILABLE_MESSAGE`).

## Acceptance Criteria

- [ ] Decide whether the ceiling (and the user cap) applies on the month estimate in this configuration
- [ ] Usage page, budget validation and gate agree on the decision (one predicate)
- [ ] Test with `AI_GATEWAY_ID` + `CF_ACCOUNT_ID` set and `CF_API_TOKEN` blank
