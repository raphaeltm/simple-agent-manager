# Stopping a deployment environment leaves its app-route DNS records pointing at the deleted node

SAM task `01M81WS0X5HPTKZESJXQWR5FB4` (coordinator `01M7XCE59V5X0WTNF1X3NFZP5J`). Affects hosted
SAM (Cloudflare). Output branch `sam/security-fix-hosted-sam-wr5fb4`.

## Problem

`POST /api/projects/:projectId/environments/:envId/stop` (`apps/api/src/routes/deployment-environment-stop.ts`)
tears down the stack, detaches volumes and deletes the managed node, but does not delete the
environment's app-route DNS records. Route DNS cleanup (`cleanupAppRouteDNSRecords`,
`apps/api/src/services/dns-app-routes.ts`) runs only on environment delete
(`deployment-environments.ts`), node delete (`routes/nodes/delete.ts`) and the release callback's
stale-route sweep.

On hosted SAM the route record is an unproxied `A` record pointing at the node's public IP. After a
stop, the record points at a cloud IP SAM has released, and the provider can reassign that IP to
another customer. That is a dangling-DNS / subdomain-takeover risk for `*.apps.<BASE_DOMAIN>`
hostnames, including on cookies scoped to the app hostname.

## Context

Found 2026-11-22 during hosted staging verification of PR #2974 (primary staging). Environment
`01KVJDV913S8W7KK32HTZTK0H8` ("Test Project 1") was stopped at about 14:58Z. The response was
`nodeDeleted: true`, and node `01M81V20VP4B69FHWAFWFZFDSS` is `deleted` with `ip_address` null. At
15:05Z the Cloudflare zone still held `A r1-app-80-01kvjdv913s8w7kk32htztk0h8.apps.sammy.party →
49.12.32.195` (unproxied). PR #2974 does not change the stop path; this predates it on `main`.

## Research findings

- Every managed node deletion funnels through `deleteNodeResourcesStrict`
  (`services/strict-node-deletion.ts`): stop (`cleanupDeploymentNode`), failed start
  (`cleanupFailedEnvironmentStart` → `cleanupDeploymentNodeIfUnassigned` → `cleanupDeploymentNode`),
  the scheduled backstop (`runDeploymentNodeCleanup`), node delete (`deleteNodeResources` →
  strict), the generic node cleanup sweep (`scheduled/node-cleanup/shared.ts`), provisioning race
  cleanup, TaskRunner cleanup. It writes the termination proof and is the one point every release
  path shares (rule 59). `nodes.ip_address` survives until `retireDeletedDeploymentNodeRecord`.
- Hostnames are `r{n}-{service}-{port}-{envId lowercased}.apps.{baseDomain}`
  (`buildRouteHostname`, `packages/app-deployment/src/deployment-routing.ts`); env ids are ULIDs.
- Existing hostname-based cleanup derives names from release manifests; an environment unlinked
  from its node before teardown (failed start, stop) is invisible to node-keyed lookups. The IP is
  the node's own key for every record it served, so release-time cleanup lists records by
  `content.exact=<ip>` under `name.endswith=.apps.<BASE_DOMAIN>`.
- Cloudflare list API supports `type`, `name.endswith`, `content.exact`, `page`, `per_page`,
  `order=name` (developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/).
- The self-host box DNS backend (`selfhost/dns/records.ts`, #2959) has no list method; it needs a
  paged suffix/content list for the same seam.
- One liveness predicate decides both paths: a record is live iff it parses as an app route of an
  existing environment whose linked node is not `destroying`/`deleting`/`deleted` and whose
  `ip_address` equals the record content. Deletion re-reads the record by name and deletes only
  the observed id if its content is unchanged (narrows the race with a concurrent release upsert).

## Implementation checklist

- [x] `services/dns-app-route-inventory.ts` + `services/app-route-dns-reconciliation.ts`: strict hostname parser, paged lister (Cloudflare +
      box seam), liveness predicate (one D1 query per batch, bind-limit aware), guarded deleter,
      `releaseNodeAppRouteDnsRecords(env, node)` and `runAppRouteDnsReconciliation(env)`
- [x] Box backend: `listARecords({ nameSuffix, content, page, perPage })`
- [x] Call release cleanup from every proof branch of `deleteNodeResourcesStrict` for VM nodes
      with an IP; failure throws (retryable, fail closed)
- [x] Scheduled sweep wired into the cron (`scheduled/node-teardown-sweeps.ts`) via `sweeps.isolate`, deadline-bounded,
      resumable page cursor in KV, per-tick delete cap, structured per-deletion logs
- [x] Configurable knobs with `DEFAULT_*` constants
- [x] Fake Cloudflare DNS that enforces the list/delete contract (rule 23)
- [x] Tests: stop route on real SQL removes records; start's release-fetch upsert recreates them;
      failed start, scheduled cleanup and node delete paths; sweep deletes dangling, keeps live,
      never touches non-app records; box backend path; each guard deleted once
- [x] Docs: deployment/self-hosting docs mention the sweep and its config
- [x] Staging: stop/start on Test Project 1 `staging` env; sweep removed the dangling record (16:30Z); re-verified on 191ca380b (start recreated, stop and node delete removed, deletion before provider teardown)
- [x] Production: merged as 7d40cfb2 (PR #2976), Deploy Production run 45098100530 succeeded; first sweep 2026-11-23T02:15:35Z examined 11, deleted 9 (`no_linked_node`), kept 2, failed 0, unjudged 0, full cycle (read-only token, Workers Observability)

## Acceptance Criteria

- [x] Stop deletes every route record of the environment once its node is released, and Start
      recreates them through the existing release-fetch upsert
- [x] A test through the real stop route asserts the records are gone after a stop that deletes the node
- [x] A bounded, isolated, logged sweep removes existing dangling app-route records and never
      touches records outside SAM's app-route naming

## Implementation notes

- Shared choke point: `deleteNodeResourcesStrict` calls `releaseNodeAppRouteDnsRecords` last in
  every termination-proof branch. Sweep: `runAppRouteDnsReconciliation` in the node teardown
  group of the 5-minute cron (`scheduled/node-teardown-sweeps.ts`).
- Review fixes (a1d54bf8b): termination proof counts as released (status `error` after VM
  deletion); per-record re-judge on fresh D1 before delete (recycled IP); unreadable rows don't
  wedge teardown; release bounded by `appRouteDns.sweepBudgetMs`; delete cap default 50.
- Guard-deletion proofs: every guard's removal turns at least one named test red (recorded in
  the PR body). The type check and the re-read type check back each other up; removing both
  turns "never deletes a non-A record" red.
- Workspace shell `CF_TOKEN` is a placeholder; real values only via `exec_with_secrets`.

## Disposition

Residual (VM deleted at the provider outside SAM keeps a `running` row and its records): merge
approved by Raphaël on inbox `ask:01M81WSGNWTXAX5BNDNAYR25RM` (2026-11-23); tracked as idea
`01M81Z9P6QFX4M9Q83K2XKGZVR`. Deferred LOWs: idea `01M82CP3VN3K74J01MVEANW16X`; staging start/stop
blockers on recycled IPs: idea `01M822HR6XW0QG3QX5SSYR05V8`.
