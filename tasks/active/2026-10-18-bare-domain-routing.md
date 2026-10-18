# Bare-domain marketing routing

Owner: SAM task 01M58JBASXK9S8WA29B8A9QHKY; idea 01M4ZAEM6HSQE0Q6VZ9R9W9GEE.

## Problem and research

2026-10-18 public GET checks: HTTP/HTTPS simple-agent-manager.org and HTTPS /docs/?routing_probe=1 return 522; www and app / and API /health return 200. Canonical marketing URL is https://www.simple-agent-manager.org (apps/www/astro.config.ts; deploy-www.yml). Existing provision-www.yml already creates a proxied placeholder apex A record and intends a scheme-independent apex-only forwarding Page Rule to https://www.<domain>/$1 (301). Its only retained provisioning run 22300482327 failed; logs expired (410). Inline curl piped to jq can report success even for success:false, and lookup excludes disabled rules. Live CF inspection is currently unavailable: production debugging token zone-list 403, connected CF accounts return no matching zone. Do not assert the exact historical failure cause.

Prefer repairing the existing managed Page Rule, retaining existing DNS/TLS/firewall/Worker routes. Cloudflare documents that omitted scheme matches HTTP and HTTPS and trailing wildcard includes path/query: https://developers.cloudflare.com/rules/page-rules/reference/wildcard-matching/ . No new infrastructure product or credential scopes.

## Checklist

- [x] Check current main and sole ownership; reproduce public symptom read-only.
- [x] Implement bounded, fail-closed Page Rule reconciliation with default read-only plan.
- [x] Add isolated plan/apply operations to existing workflow without DNS/Pages provisioning.
- [x] Reuse reconciliation in existing marketing provision workflow.
- [x] Regression tests: missing/inactive/current/ambiguous rule, API failures, HTTP+HTTPS path/query contract, unrelated routing untouched.
- [x] Relevant lint, typecheck and tests; independent specialist review.
- [ ] Draft PR and concrete design sent to Astra; CI and CodeRabbit gates.
- [ ] Coordinate existing deployment lease; classify network risk before application.
- [ ] Apply only after gates and any required exact approval; public smoke on apex/www/app/API.

## Acceptance and safety

Both apex schemes permanently redirect to HTTPS www retaining paths/query; subdomains excluded. No unrelated DNS/firewall/TLS/credential/permission changes. Plan reports exact mutation. Application is manual, serialized, and fails on API errors/ambiguous ownership. No paid browser, no production authenticated journey, no held PR mutation. Keep task active until deployed and verified; preserve .do-state.md continuation.

## Preparation evidence

Local independent Cloudflare/security/constitution review PASS: exact apex forwarding_url301 is public routing repair without security-sensitive settings. Use only apply-redirect; never provision for this repair. Test/docs/completion review PASS for draft preparation; final completion remains pending application and public smoke. No production authenticated journey or VM lifecycle is relevant to this apex-only rule; any genuine gate conflict must be reported, not silently waived.

Relevant checks: infra 9 files/72 tests pass, infra typecheck/lint pass; scripts/deploy typecheck, focused script lint and node syntax pass; marketing workflow/name/teardown regression suite passes. Contract tests do not substitute for real public smoke. Full historical root cause cannot be asserted from expired run logs.

## Live finding and revised design

Read-only plan runs 39173562569 and 39173638664 passed zone/proxied-apex checks, skipped all DNS/Pages mutations, and failed Page Rules GET with HTTP400/code1011. Cloudflare's official issue https://github.com/cloudflare/cloudflare-docs/issues/23256 and account-owned token compatibility matrix identify Page Rules as unsupported for account-owned tokens. Increasing permissions would not fix that API incompatibility. No credentials or permissions changed.

Superseding initial PageRule design: use one Single Redirect in the supported Rulesets `http_request_dynamic_redirect` phase, ref `sam_apex_to_www`, exact host expression, dynamic HTTPS www + original URI path and preserve_query_string=true. Create an absent entrypoint containing only this rule; otherwise append or PATCH only the owned rule. Never replace an existing whole ruleset, security phase or unrelated rule. Keep legacy teardown cleanup and add owned-rule cleanup to existing teardown paths; do not execute teardown. Re-review and live plan required before apply.
