# Multi-installation Cloudflare domain namespaces groundwork

## Constraint

This work must end in a **draft PR**. Do not mark the PR ready, deploy it to production, or merge it without later explicit authorization from Raphaël.

## Problem

SAM currently assumes `BASE_DOMAIN` is also the Cloudflare zone apex. That assumption prevents two independent SAM installations from sharing one purchased domain/Cloudflare zone safely:

- Pulumi creates zone-relative DNS records named `api`, `app`, and `*`, so installations targeting different nested deployment domains still collide at the zone apex.
- Generated Wrangler routes set `zone_name` to `BASE_DOMAIN`, which is invalid when the deployment domain is a nested subdomain of the actual zone.
- Runtime workspace and VM DNS creation sends zone-relative names (`ws-{id}` and `{nodeId}.vm`) instead of names qualified by the deployment domain.
- Public documentation therefore instructs self-hosters to buy/use a separate apex domain rather than explaining the supported certificate tradeoff for nested deployment domains.

The first groundwork slice should make a deployment such as `dev-a.sammy.party` independently addressable inside the existing `sammy.party` zone while preserving current production/staging behavior. This enables one Cloudflare account and zone to host multiple SAM installations without requiring one purchased domain per installation.

## Research findings

- `infra/resources/config.ts:parseInfraConfig` already derives a distinct resource prefix from each `BASE_DOMAIN`, so nested deployment domains naturally produce distinct D1/KV/R2/Worker/Pages names.
- `infra/resources/dns.ts` creates zone-relative `api`, `app`, and `*` records and must instead use fully qualified names derived from `BASE_DOMAIN`.
- `infra/resources/pages.ts` already registers the exact `app.${BASE_DOMAIN}` custom domain.
- `scripts/deploy/sync-wrangler-config.ts:getApiWorkerRoutes` builds correct nested route patterns but incorrectly sets `zone_name=BASE_DOMAIN`. Pulumi already has `cloudflareZoneId`; exporting it lets Wrangler routes bind to the real zone by ID without adding another manually configured variable.
- `apps/api/src/services/dns.ts:createDNSRecord` and `createNodeBackendDNSRecord` use relative record names. Cleanup already searches fully qualified names, so creation and cleanup are currently asymmetric for nested domains.
- `infra/resources/origin-ca.ts` and `apps/api/src/services/origin-ca-certificates.ts` already derive exact deployment-domain wildcard hostnames; nested origin TLS is structurally supported.
- On a full Cloudflare zone, free Universal SSL covers only the apex and first-level subdomains. Nested public hosts require Total TLS/Advanced Certificate Manager or explicitly managed certificates. This PR must document that tradeoff rather than imply nested deployment domains are cost-free at the certificate layer.
- The retained DNS cleanup incident in `tasks/archive/2026-06-13-app-route-dns-and-environment-teardown-cleanup.md` shows that creation and cleanup must use one canonical hostname derivation; stale historical schemes left orphaned DNS records.
- The current task does **not** implement agent environment leasing, credential brokering, safe arbitrary-stack teardown, or the future flat hostname layout (`app--namespace.zone`). Those remain follow-up slices.
- An apex installation's greedy Worker wildcard can receive nested installation traffic during route provisioning/teardown. Sibling nested installations are disjoint, but strong apex-plus-nested isolation remains shared-ingress follow-up work.

## External references

- Cloudflare Workers route matching and `zone_id`: https://developers.cloudflare.com/workers/configuration/routing/routes/
- Cloudflare wildcard DNS behavior: https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/
- Cloudflare Universal SSL hostname depth: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/

## Implementation checklist

- [x] Add failing tests for fully qualified Pulumi DNS names when `BASE_DOMAIN` is nested under the Cloudflare zone.
- [x] Centralize Pulumi deployment hostname derivation so DNS, Pages, route exclusions, and exported hostnames use the same values.
- [x] Export `cloudflareZoneId` from Pulumi and validate/type it as a required deployment output.
- [x] Generate Wrangler API/workspace routes with `zone_id`, never `zone_name=BASE_DOMAIN`.
- [x] Add failing API DNS tests for fully qualified workspace and VM backend record names.
- [x] Make runtime DNS creation use `ws-{id}.${BASE_DOMAIN}` and `{nodeId}.vm.${BASE_DOMAIN}` while preserving cleanup symmetry.
- [x] Verify domain-derived resource prefixes differ for two installation deployment domains in the same zone.
- [x] Update public self-hosting and configuration documentation with the one-zone/multiple-installations model and nested TLS requirements.
- [x] Update environment-variable reference/instructions where `BASE_DOMAIN` is incorrectly described as necessarily being the zone apex.
- [x] Run focused tests for infra, Wrangler generation, and API DNS helpers.
- [x] Run the full lint, typecheck, test, and build suite.
- [x] Complete Cloudflare, environment-variable, constitution, documentation-sync, test-quality, and task-completion specialist reviews.
- [x] Perform required staging and real-VM infrastructure verification without overlapping another active staging deployment.
- [x] Open draft PR [#1571](https://github.com/raphaeltm/simple-agent-manager/pull/1571) and stop without marking it ready or merging it.
- [x] Replace the invalid per-prefix `workers.dev` CNAME assumption with Cloudflare's documented proxied originless DNS records.
- [x] Add sibling-installation route, hostname, and runtime cleanup isolation tests after critical local review.

## Acceptance criteria

- Existing deployments with `BASE_DOMAIN` equal to the zone apex produce the same public hostnames and resource identities as before.
- A deployment with `BASE_DOMAIN=dev-a.example.com` and the `example.com` zone creates/targets:
  - `api.dev-a.example.com`
  - `app.dev-a.example.com`
  - `*.dev-a.example.com`
  - `*.vm.dev-a.example.com`
- Generated Worker routes use the configured Cloudflare zone ID while matching the nested deployment-domain patterns.
- Workspace and VM backend DNS API requests carry fully qualified record names under the deployment domain.
- Two deployment domains inside one zone derive different default resource prefixes.
- Tests cover legacy apex-domain behavior, nested-domain behavior, and missing/invalid required output failure.
- Public docs state that nested deployment domains reuse one purchased domain/zone but require appropriate deep-subdomain edge certificate coverage.
- The PR clearly marks the following as deferred: flat first-level hostname namespaces, shared zone ingress ownership, agent-cell leasing, credential bootstrap/brokering, and generic safe teardown.
- The PR remains draft and unmerged.

## Constitution and risk check

- **Principle II — Infrastructure Stability:** DNS management is a critical path; use test-first changes and real staging/VM verification.
- **Principle III — Documentation Excellence:** update canonical public self-hosting/configuration docs with actual supported behavior and certificate constraints.
- **Principle XI — No Hardcoded Values:** derive all hostnames from `BASE_DOMAIN` and bind routes using the configured `CF_ZONE_ID`/Pulumi output.
- Primary risks are DNS collisions, orphaned records, route attachment to the wrong zone, TLS coverage gaps, and accidental changes to existing production/staging hostnames.

## Specialist review evidence

| Reviewer                    | Status    | Outcome                                                                                                                                                                         |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare-specialist`     | PASS      | FQDN DNS, parent-zone routes, Pages, Origin CA, and output validation are sound. The pre-existing wildcard Worker/Pages overlap remains deferred with shared ingress ownership. |
| `env-validator`             | PASS      | No new variable or secret mapping is required; `BASE_DOMAIN` and `CF_ZONE_ID` semantics are consistent.                                                                         |
| `constitution-validator`    | PASS      | All installation identities derive from `BASE_DOMAIN` and `CF_ZONE_ID`; no new hardcoded deployment values.                                                                     |
| `doc-sync-validator`        | ADDRESSED | Parent-zone terminology findings fixed in `e895a0137`; docs build passes.                                                                                                       |
| `test-engineer`             | ADDRESSED | Cleanup and integrated nested Pulumi wiring hardening added in `704cb5748`; no remaining findings.                                                                              |
| `task-completion-validator` | PASS      | Checks A–F pass; deferred architecture and pending release gates are explicit.                                                                                                  |

## Staging verification evidence

- GitHub Actions run `29189719745` deployed the branch to staging successfully; Cloudflare deployment and all 12 smoke tests passed.
- Cloudflare DNS resolved the expected apex deployment names: `api.sammy.party`, `app.sammy.party`, and `*.sammy.party` were proxied to the API Worker/Pages targets.
- Authenticated Playwright verification loaded dashboard, projects, settings, and health successfully with no console or page errors.
- Disposable workspace `01KXAZYGM50FRQCQD9WH4FKY72` on node `01KXAZYG77GVVHEJVPXKBEM512` reached `running`; its public Worker proxy returned a healthy backend response, terminal WebSocket opened and received data, an agent-session host completed create/list/stop, and workspace/node/DNS cleanup succeeded.
- A second cold node (`01KXB0HJ5Q6Y37RD2X7R5DBPYA`) repeated the first-heartbeat measurement: provider `running` at `2026-07-12T11:14:06.558Z`, first heartbeat at `2026-07-12T11:16:22.302Z` (135.7 seconds). Diagnostics showed the overage occurred during ordinary VM/cloud-init package setup before the branch's routing path; DNS, origin TLS, and authenticated Worker-to-VM proxying were healthy in the full-path run. Its workspace/node records and backend DNS record were removed after measurement.
- Observability noise check passed. D1 noise inspection was unavailable because `OBSERVABILITY_DB_ID` was unset, and Cloudflare telemetry was unavailable to the token (403); the deployment workflow, smoke suite, browser flow, real VM, DNS, TLS, WebSocket, session lifecycle, and cleanup supplied the release evidence for this bounded infrastructure slice.

## References

- SAM idea `01KX9702VSZBPXWHVT1225Q8PN`
- `infra/resources/config.ts`
- `infra/resources/dns.ts`
- `infra/resources/pages.ts`
- `scripts/deploy/sync-wrangler-config.ts`
- `apps/api/src/services/dns.ts`
- `.claude/rules/07-env-and-urls.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `tasks/archive/2026-06-13-app-route-dns-and-environment-teardown-cleanup.md`
- `apps/www/src/content/docs/docs/guides/self-hosting.mdx`
- `apps/www/src/content/docs/docs/reference/configuration.md`
