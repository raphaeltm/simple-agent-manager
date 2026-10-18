# Bare-domain marketing routing

Owner: SAM task 01M58JBASXK9S8WA29B8A9QHKY; idea 01M4ZAEM6HSQE0Q6VZ9R9W9GEE. Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/2376 . Actual model setting: gpt-6.1-sol.

## Problem and research

2026-10-18 public GET checks: HTTP/HTTPS simple-agent-manager.org and HTTPS /docs/?routing_probe=1 return522; www and app / and API /health return200. Canonical marketing URL is https://www.simple-agent-manager.org (apps/www/astro.config.ts; deploy-www.yml). Existing provision-www.yml creates a proxied placeholder apex A record and intends an apex→www301 Page Rule. Its only retained historical run22300482327 failed, with logs expired410; historical exact failure cause is unproven.

Live read-only plan39173562569 passed zone/proxied-apex checks, skipped DNS/Pages mutations, and failed Page Rules GET400. Diagnostic plan39173638664 identified code1011. Official Cloudflare issue23256 and the account-token compatibility matrix confirm Page Rules are incompatible with account-owned tokens; Rulesets are supported. No token or permission changes were made.

The final implementation uses one Single Redirect in the supported Rulesets `http_request_dynamic_redirect` zone phase, ref `sam_apex_to_www`, expression `(http.host eq "<baseDomain>")`, target `concat("https://www.<baseDomain>", http.request.uri.path)`, status301, preserve_query_string=true. Append/PATCH only the owned rule, or create an absent redirect entrypoint containing that rule. Never replace an existing whole ruleset. The exact phase entrypoint is read directly (no paginated list inference); only exact endpoint404/code10003 means absent. Zone, proxied DNS, phase, ownership and mutation responses are checked; unrelated rule definitions/order must remain intact. Existing teardown paths remove only the owned rule, preserving the entrypoint; no teardown is executed for this repair.

## Checklist

- [x] Check current main and sole ownership; reproduce public symptom read-only.
- [x] Implement bounded, fail-closed Single Redirect reconciliation with default read-only plan.
- [x] Add isolated plan/apply operations to the existing workflow; gate DNS/Pages provisioning separately.
- [x] Prepare narrow managed-rule teardown cleanup with existing confirmation/opt-in/dry-run protections.
- [x] Regression tests: missing/existing/disabled/duplicate/foreign-owned rules, API failures, wrong zone, DNS preflight, HTTP+HTTPS path/query configuration, unrelated routing preserved, narrow teardown.
- [x] Relevant local validation and independent final-design specialist reviews.
- [x] Open draft PR and report concrete design for Astra review.
- [ ] CI and remaining review gates, including Astra and CodeRabbit when otherwise ready.
- [ ] Resolve existing-credential access blocker without unauthorized permission/credential changes.
- [ ] Coordinate shared deployment lease before any apply.
- [ ] Apply only after gates/required approval; public smoke apex/www/app/API; keep task active until verified.

## Validation and review evidence

Local final config suite: 81 tests across apex-redirect, deployment-workflow-hardening and teardown-workflow files pass. Independent reviewer reran apex+teardown subset:19 tests/2 files pass. Pulumi infra:72 tests/9 files pass, including app/API/wildcard/VM exclusion routing; infra typecheck/lint pass. Deployment-script typecheck, focused ESLint, Node syntax and Prettier pass. These are config/adapter tests, not proof of live redirect behavior.

Fresh final-design Cloudflare/security/constitution review PASS for safe preparation; tests/docs/completion review PASS after this task record correction. Exact owned-rule Single Redirect is ordinary public routing configuration, not an auth/security boundary change. Full provisioning is outside the repair scope. Deployment and final completion are explicitly pending.

## Application blocker and exact approval boundary

Supported read-only plan https://github.com/raphaeltm/simple-agent-manager/actions/runs/39173865292 at2fbf1b7b7cd9cf5531060ddb811bb2550d348d60 passed production zone and proxied-apex checks, then failed GET /zones/<production CF_ZONE_ID>/rulesets with HTTP403/code10000. DNS/Pages provisioning steps were skipped. No live mutation occurred. Existing deployment credential cannot inspect the required Rulesets surface.

Target: production simple-agent-manager.org, `http_request_dynamic_redirect` phase, only ref `sam_apex_to_www`. Intended diff: absent entrypoint→zone redirect entrypoint with one exact-apex301; or append/PATCH that rule in an existing entrypoint. Actual live before-state cannot be determined until read access succeeds. Original path and query retained; www/app/api/preview/workspace/VM hosts excluded. No DNS/TLS/firewall/security-phase changes.

If no already-approved credential can perform this operation, explicit user approval is needed before granting the existing production deployment token `Zone > Dynamic URL Redirects > Edit`, scoped only to simple-agent-manager.org. That scope allows editing other dynamic redirects in the zone, so it is a persistent permission expansion despite the narrow code path. No new token, other scope or secret change is authorized. After approval/access: rerun plan, inspect exact live diff, recheck Astra/CI/CodeRabbit gates, acquire lease, apply-redirect only, then public smoke. Do not use provision or teardown for this repair.

Shared staging: recovery owner01M58JARRQQ01A3DB9JEDA2E9G has the next bounded validation slot by peer agreement; apex has no deployment reservation while blocked. No shared schema/migration changes or release dependencies.

## References

- https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/
- https://developers.cloudflare.com/ruleset-engine/rulesets-api/add-rule/
- https://developers.cloudflare.com/ruleset-engine/rulesets-api/update-rule/
- https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/
- https://github.com/cloudflare/cloudflare-docs/issues/23256

## Safety and completion

No paid browser runs. Authenticated journeys are staging only; production gets basic public smoke only. No held PR mutations, raw production DB repair, new credentials, permission grants, sensitive network settings or financial commitments. User requested draft PR early, so draft precedes application. SAM isolated checkout/assigned branch reused; task record stays in this PR to avoid concurrent direct-main release writes. Keep .do-state.md and PR current; do not archive or complete task before verified outcome.
