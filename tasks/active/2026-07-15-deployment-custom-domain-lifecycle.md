# Deployment custom-domain lifecycle, activation, and stop/start UX

## Problem statement

SAM's deployment custom-domain feature currently treats custom domains as
release-apply decoration. A user can attach and verify DNS, but the deployment
node only receives the changed hostname list during a later application release
apply. Delete removes the D1 row immediately, while the old Caddy site block can
continue serving until a later apply or teardown.

This creates incorrect product states:

- `verified` means DNS matched, not that the domain is serving.
- Deleting a domain can report success while the hostname still serves.
- Stopped/error environments hide preserved custom-domain rows because the
  route selector returns no active public routes.
- Route reordering can change a generated SAM CNAME target while old
  verification still appears valid.
- Domain lifecycle history is not durable enough for debugging.

This task implements the post-ship lifecycle audit in SAM idea
`01KVWRSBBQW1RNXRGGJAAG009K`. The goal is a real routing reconciliation path:
custom-domain verify/delete must update desired routing configuration, have the
node apply route-only Caddy changes, and expose observed serving state to users.

## Research findings

### Prior product decisions and task records

- Idea `01KVWRSBBQW1RNXRGGJAAG009K` was updated on 2026-07-12 with the
  post-ship audit. It supersedes the earlier "active on next deploy" UI slice.
- Archived v1 implementation task:
  `tasks/archive/2026-06-24-custom-domains-deployment-public-routes.md`.
  It intentionally appended verified domains to the next signed `ApplyPayload`
  and stated "Deleting a custom domain drops its site block on next apply."
- Active UI task:
  `tasks/active/2026-06-24-deployment-custom-domain-ui.md`.
  The UI shipped the Domains tab, but explicitly kept the deferred activation
  copy because route re-apply was not implemented.
- Release/callback postmortem task:
  `tasks/archive/2026-06-25-control-plane-deployment-release-fixes.md`.
  Relevant lesson: VM-agent callback routes must be mounted before session-auth
  routes, and heartbeat/reconcile updates must be scoped to what the node
  actually reported.
- Caddy routing/TLS task:
  `tasks/active/2026-06-12-productionize-caddy-routing-tls.md`.
  Important constraints: Caddy reload must happen on-node from a signed route
  payload, app-route DNS stays control-plane owned, and real staging must prove
  DNS/TLS/HTTPS on a deployment node.

### Current backend flow

- `apps/api/src/routes/deployment-custom-domains.ts`
  - `POST /custom-domains` inserts pending rows.
  - `POST /:domainId/verify` only sets
    `verificationStatus`, `verificationError`, and `verifiedAt`.
  - `DELETE /:domainId` physically deletes the row and returns `{deleted:true}`.
  - No route-only reconciliation is triggered.
- `apps/api/src/services/deployment-custom-domains.ts`
  - `buildVerifiedCustomRouteTargets()` appends verified domains only when an
    application release payload is built.
  - Parent matching is by `service + containerPort`.
- `apps/api/src/routes/deploy-release-callback.ts`
  - Only `GET /api/nodes/:id/deploy-release?seq=N&environmentId=E` returns a
    signed payload.
  - Verified custom domains are appended to the `routes` array before signing.
- `apps/api/src/routes/node-lifecycle.ts`
  - Heartbeat advertises `pendingReleases` only when
    `latest.version > appliedSeq`.
  - There is no independent desired/observed routing revision.
- `apps/api/src/routes/deployment-environments.ts`
  - `GET .../public-routes` currently returns `[]` when
    `environment.status !== 'active'`, which causes the Domains panel to hide
    preserved domains while stopped/error.
- `apps/api/src/db/schema.ts`
  - `deployment_custom_domains` only stores verification state.
  - `deployment_release_events.node_id` and `deployment_publish_job_events.node_id`
    still cascade on node delete; the idea requires durable lifecycle history.

### Current VM-agent flow

- `packages/vm-agent/internal/server/health.go`
  - Deployment heartbeat sends `appliedSeq`, `status`, service state, and
    day-2 telemetry.
  - It only reacts to `pendingReleases`.
- `packages/vm-agent/internal/deploy/engine.go`
  - `Apply()` verifies a signed application payload, writes compose+Caddy files,
    runs compose, health-checks, reloads Caddy, and sets `current`.
  - `reloadCaddy()` already writes the active per-environment Caddy snippet and
    reloads Caddy without restarting app containers.
  - A route-only apply can reuse Caddy generation/reload without running compose.
- `packages/vm-agent/internal/deploy/signature.go`
  - Current signature contract rejects replay by requiring `payload.Seq >
lastAppliedSeq`, which is correct for application release applies but not for
    route-only revisions. A separate route-config signature/verifier contract is
    cleaner than overloading application release signatures.

### Current UI flow

- `apps/web/src/components/deployments/DeploymentCustomDomainsPanel.tsx`
  - Uses hand-rolled loading state. Modified fetch surfaces should move to
    TanStack Query or preserve stale-while-revalidate behavior.
  - Shows "Verified" with copy saying activation happens on next deployment
    apply.
  - Hides all domain cards behind a single "No public routes" empty state when
    `routes.length === 0`.
  - Groups rows by `service:port:routeIndex`, while backend matching mostly uses
    `service + port`.
- `apps/web/src/lib/api/deployment.ts`
  - Types must be extended with serving/routing state and the revised delete
    response.

### Rules and constraints read

- `.codex/prompts/do.md` and `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/03-constitution.md` and `.specify/memory/constitution.md`
  must be validated before completion.
- `.claude/rules/06-api-patterns.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/22-infrastructure-merge-gate.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/29-local-first-debugging.md`
- `.claude/rules/30-never-ship-broken-features.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/48-stale-while-revalidate-ui.md`

### Product knowledge applied

- Custom domains should appear in deployment route discovery as effective public
  entrypoints, especially when app configuration depends on public domains.
- Raphaël primarily uses SAM from mobile; mobile overflow/visibility failures
  are high-risk.

## Design direction

Implement an independent route-config revision path:

1. Add desired/observed routing revision fields to deployment environments.
2. Add custom-domain fields for target verification, desired deletion, routing
   revision tracking, and observed serving state.
3. Add append-only custom-domain lifecycle events.
4. On successful DNS verification, record the verified target and increment the
   environment desired routing revision.
5. On delete, mark the domain `deactivating`, increment desired routing
   revision, and keep the row visible until the node reports the revision
   applied.
6. Extend heartbeat response with pending route-config revisions when desired
   revision exceeds observed revision for an active/starting environment with an
   applied release.
7. Add a callback-JWT route under `/api/nodes` for the node to fetch a signed
   route-config payload for the desired revision.
8. Add VM-agent route-only fetch/apply support that verifies a route-config
   signature, writes the current release's Caddy snippet with the new routes,
   reloads Caddy, persists the observed routing revision, and never runs Docker
   compose.
9. Heartbeat reports observed routing revision/status/error. The Worker updates
   D1 and finalizes `deactivating` domains once the route revision is observed.
10. UI displays DNS status, route-config status, serving state, stopped/error
    inactive state, and deactivating state without hiding rows behind the route
    selector.

Route identity is handled safely in this slice by storing the verified CNAME
target. If a later manifest reorder changes the generated SAM route hostname,
the domain must become `dns_recheck_required` / `verified_unapplied` rather than
silently serving or hiding under the wrong route. A full manifest-authored stable
route alias can remain a follow-up only if the safe target-change detection is
implemented and tested here.

## Implementation checklist

### Phase A — Additive schema and types

- [x] Add migration `0094_deployment_custom_domain_lifecycle.sql` with additive
      columns only:
  - [x] `deployment_environments.desired_routing_revision INTEGER NOT NULL DEFAULT 0`
  - [x] `deployment_environments.observed_routing_revision INTEGER NOT NULL DEFAULT 0`
  - [x] `deployment_environments.observed_routing_status TEXT`
  - [x] `deployment_environments.observed_routing_error TEXT`
  - [x] `deployment_environments.observed_routing_at TEXT`
  - [x] `deployment_custom_domains.verified_cname_target TEXT`
  - [x] `deployment_custom_domains.desired_state TEXT NOT NULL DEFAULT 'active'`
  - [x] `deployment_custom_domains.routing_status TEXT NOT NULL DEFAULT 'pending_dns'`
  - [x] `deployment_custom_domains.activation_routing_revision INTEGER`
  - [x] `deployment_custom_domains.deactivation_routing_revision INTEGER`
  - [x] `deployment_custom_domains.deleted_at TEXT`
  - [x] helpful indexes for environment/routing status/desired state.
- [x] Add `deployment_custom_domain_events` append-only table with nullable
      `node_id` or denormalized node identifier so events survive node deletion.
- [x] Change `deployment_release_events.node_id` and
      `deployment_publish_job_events.node_id` to survive node deletion without
      table recreation if safely possible. If not safely possible in SQLite/D1,
      add denormalized immutable node id fields and update writes/reads to use
      them for historical display.
- [x] Update Drizzle schema/types.
- [x] Run `pnpm quality:migration-safety`.

### Phase B — Control-plane routing revision service

- [x] Create a service that increments an environment's desired routing revision
      and records a lifecycle event in one logical operation.
- [x] Extend custom-domain responses with:
  - [x] `routingStatus`
  - [x] `servingStatus`
  - [x] `desiredState`
  - [x] `verifiedCnameTarget`
  - [x] `activationRoutingRevision`
  - [x] `deactivationRoutingRevision`
  - [x] environment lifecycle/routing context needed by the UI.
- [x] Ensure `buildVerifiedCustomRouteTargets()` includes only domains that:
  - [x] are verified,
  - [x] are not deactivating/deleted,
  - [x] still match the current expected CNAME target,
  - [x] have a matching parent route.
- [x] Add target-change detection so route reorder/target changes reset or
      surface re-verification instead of silently treating stale DNS as active.
- [x] Add lifecycle event recording for attach, verify success/failure,
      activation requested, activation observed, delete requested, deactivation
      observed, route missing, and target changed.

### Phase C — Browser API route behavior

- [x] Update `POST /custom-domains` to initialize routing/desired state and
      return the enriched response.
- [x] Update `POST /:domainId/verify`:
  - [x] Verify DNS against current expected target.
  - [x] On success, store `verified_cname_target`, mark routing as activating or
        active depending on observed revision, increment desired routing revision,
        and record events.
  - [x] On failure, store safe, copyable error detail and avoid routing changes.
- [x] Change `DELETE /:domainId` from immediate physical delete to "request
      deactivation":
  - [x] mark desired state deactivating,
  - [x] increment desired routing revision,
  - [x] record event,
  - [x] return 202/enriched domain state instead of `{deleted:true}`.
- [x] Add any cleanup/finalization helper that can mark deactivated rows
      `deleted_at` / remove them only after observed node revision confirms the
      route was dropped.
- [x] Update `GET /custom-domains` to keep preserved domains visible even when
      routes are inactive/missing.
- [x] Update `GET /public-routes` to derive from the latest stored release even
      when the environment is stopped/error, and include a live/inactive flag
      instead of returning `[]` solely due to environment status.

### Phase D — Node heartbeat and route-config callback

- [x] Extend API heartbeat parsing to accept observed route config state:
      `routingRevision`, `routingStatus`, `routingError`.
- [x] When desired routing revision exceeds observed routing revision, advertise
      `pendingRouteConfigs: [{ environmentId, revision }]` only when:
  - [x] environment is active/starting,
  - [x] an app release is currently applied,
  - [x] volume readiness gates are satisfied for volume environments.
- [x] Add `GET /api/nodes/:id/deploy-routes?revision=R&environmentId=E`
      as a callback-JWT route mounted before session-auth node routes.
- [x] The route-config payload must be signed with the deploy signing key and
      include environment id, node id, current applied release seq, routing
      revision, expiry, and route targets.
- [x] Add route-order/auth tests proving VM-agent callback JWT auth works and
      session-auth middleware cannot intercept the new callback route.
- [x] Add D1/route tests proving verify/delete queue pending route configs.

### Phase E — VM-agent route-only reconciliation

- [x] Add Go route-config payload/signature types and verifier methods separate
      from application release `ApplyPayload` replay rules.
- [x] Extend heartbeat response parsing with `pendingRouteConfigs`.
- [x] Add `FetchAndApplyRoutes(ctx, revision)`:
  - [x] fetch signed route-config payload,
  - [x] verify environment/node/current release seq/revision/expiry/signature,
  - [x] generate Caddy snippet from routes,
  - [x] write the current release's Caddyfile/snippet,
  - [x] reload Caddy,
  - [x] update current release metadata with routing revision/status,
  - [x] update observed heartbeat state.
- [x] Ensure route-only apply does not run `docker compose pull/up/down` and does
      not change `appliedSeq`.
- [x] Add Go tests for success, signature replay/revision mismatch, no-current
      release, Caddy reload failure, and "no compose commands invoked."

### Phase F — UI behavior

- [x] Replace the "active on next deployment apply" copy with explicit DNS vs
      routing vs serving state.
- [x] Keep saved domains visible while environment status is stopped, starting,
      or error.
- [x] Show inactive/stopped, start failed, route missing, activating,
      active, deactivating, DNS mismatch, and target-changed/recheck states.
- [x] Adjust delete UI to show "deactivation requested" until observed rather
      than immediately removing the row.
- [x] Group domains by stable parent service/port when routeIndex changes, and
      show a warning if the expected CNAME target changed.
- [x] Use TanStack Query or otherwise preserve stale-while-revalidate behavior
      without unmounting visible content on refetch.
- [x] Keep mobile layout at 375px free of horizontal overflow.

### Phase G — Tests and verification

- [x] API unit/integration tests for enriched custom-domain states, route target
      changes, delete/deactivation behavior, public-routes while stopped/error,
      lifecycle events, and routing revision updates.
- [x] Heartbeat vertical-slice tests for verify → pending route config →
      observed active, and delete → pending route config → deactivated.
- [x] Go tests for route-only apply and route-config signature contract.
      Added in `packages/vm-agent/internal/deploy/routes_test.go`; local execution
      is blocked because this workspace has no `go` or `gofmt` binary.
- [x] Cross-boundary tests proving TypeScript route-config payload shape matches
      Go decoding/signature verification.
- [x] Frontend component tests for state mapping and delete/deactivation UI.
- [x] Playwright visual audit for Domains tab with normal data, stopped/error
      preserved domains, long hostnames, many domains, route-missing, and error
      states at 375x667 and 1280x800.
- [x] Full local gates: lint, typecheck, test, build, migration safety.
      `pnpm typecheck`, `pnpm lint`, `pnpm quality:migration-safety`,
      `pnpm quality:file-sizes`, `pnpm build`, `pnpm test`, and
      `git diff --check` passed locally on 2026-07-15.
- [x] Specialist reviews: task-completion-validator, cloudflare-specialist,
      go-specialist, ui-ux-specialist, security-auditor,
      constitution-validator, test-engineer, doc-sync-validator if docs change.
      Pre-PR task-completion verdict was WARN only because staging/live DNS
      verification and local Go execution were still pending at review time.
- [x] Staging deploy and live verification:
  - [x] verify migration columns/tables through CF API,
  - [x] add test custom domain and verify DNS,
  - [x] prove it becomes active without a new app release,
  - [x] stop environment and confirm preserved inactive domain visibility,
  - [x] start replacement node and confirm verified domain restores,
  - [x] delete/deactivate domain and prove hostname no longer serves,
  - [x] verify no new browser console errors and regression checklist.

### Implementation status — 2026-07-15

- Implemented the additive D1 schema, desired/observed routing revision model,
  custom-domain lifecycle events, route-only deploy callback, heartbeat
  advertisement/reconciliation, VM-agent route-only Caddy reload path, enriched
  browser/MCP responses, and Domains tab state model.
- Release/publish history retention is addressed by denormalized node identifiers
  plus deployment-node tombstoning on deletion; this avoids unsafe D1 table
  rewrites while preventing cascade loss of history.
- Local TypeScript/web validation is green. VM-agent Go tests were added, but
  this workspace cannot execute or format Go because `go` and `gofmt` are not
  installed.
- Staging deploy `29409163762` succeeded for PR head
  `39b7ccdbe0019395edcffb604dee47590c995a81`; CF API verified the new
  environment and custom-domain schema in `sam-staging`.
- Existing volume-backed staging environment `01KVJDV913S8W7KK32HTZTK0H8`
  verified the Hetzner detach idempotency fix: stop completed with
  `volumesDetached: 1`, start provisioned replacement node
  `01KXJPV5P25EG7K7H1DW9G7TTG`, and the volume row attached to provider server
  `151196607`. The app release on that old environment still restart-looped
  because its test image exits after printing `hello from sam e2e`; that is
  unrelated to the volume/provider recovery path.
- Disposable staging environment `01KXJQ9PBNBJN5YH0FRQT2ETME` verified the full
  custom-domain lifecycle with hostname
  `pr1602-cd.178.104.223.13.sslip.io`:
  - attach returned pending DNS for the `web:8080` parent route,
  - verify stored CNAME target
    `r1-web-8080-01kxjq9pbnbjn5yh0frqt2etme.apps.sammy.party` and queued routing
    revision 1,
  - node heartbeat observed revision 1 at `2026-07-15T11:19:29.756Z`,
  - HTTPS to the custom hostname returned `200` from the test app,
  - stop preserved the domain as `inactive_environment_stopped` and left public
    routes discoverable with `routesAreLive: false`,
  - start provisioned replacement node `01KXJR630P1JR9EJ2M6NNS2Z5K`, applied
    release 1, and restored the domain as active with HTTPS `200`,
  - delete returned `202`, queued deactivation revision 2, node logs showed
    `deploy.routes: applied` for revision 2, D1 finalized the row as
    `deleted/deactivated`, and HTTPS to the custom hostname failed TLS because
    the site block was gone.
- Staging browser smoke opened the Domains tab at
  `/projects/01KJNR9R3TEN3KX1ETE33852R8/deployments/01KXJQ9PBNBJN5YH0FRQT2ETME?tab=domains`
  with the smoke-token flow; it rendered the Domains tab empty/add state and
  reported zero console/page errors.
- Cleanup deleted disposable environment `01KXJQ9PBNBJN5YH0FRQT2ETME`, deleted
  node `01KXJR630P1JR9EJ2M6NNS2Z5K`, and removed one generated app-route DNS
  record. CF DNS read-back for
  `r1-web-8080-01kxjq9pbnbjn5yh0frqt2etme.apps.sammy.party` returned zero
  records.

## Acceptance criteria

- Verify activates a domain through route-only reconciliation without requiring
  a new application release.
- Delete requests deactivation, removes the live Caddy route through route-only
  reconciliation, and only reports/removes final state after observed node
  confirmation.
- The UI distinguishes DNS verification, desired routing state, observed
  serving/TLS state, and environment lifecycle state.
- Saved domains remain visible and manageable while stopped, starting, or
  failed.
- Stop labels domains inactive but preserves associations.
- Start reattaches/mounts volumes before app and route activation, then restores
  verified domains.
- A failed Start leaves domains visible with useful environment/volume
  diagnostics.
- Route reordering or CNAME target changes cannot silently invalidate or hide
  domains; users see a required re-check/migration state.
- Custom-domain lifecycle events are durable.
- Release/publish event history is not lost solely because a deployment node is
  deleted.
- Destroy clearly distinguishes SAM resource cleanup from the user's remaining
  DNS record.
- End-to-end verification covers add → verify → active, stop → inactive
  preserved, start on a replacement node with volumes → active/data preserved,
  delete → no longer served, and route target change → safe re-check state.

## References

- SAM idea `01KVWRSBBQW1RNXRGGJAAG009K`
- `apps/api/src/routes/deployment-custom-domains.ts`
- `apps/api/src/services/deployment-custom-domains.ts`
- `apps/api/src/routes/deploy-release-callback.ts`
- `apps/api/src/routes/node-lifecycle.ts`
- `apps/api/src/routes/deployment-release-events-callback.ts`
- `apps/api/src/routes/deployment-environments.ts`
- `apps/api/src/db/schema.ts`
- `packages/vm-agent/internal/server/health.go`
- `packages/vm-agent/internal/deploy/engine.go`
- `packages/vm-agent/internal/deploy/signature.go`
- `packages/vm-agent/internal/deploy/caddy.go`
- `apps/web/src/components/deployments/DeploymentCustomDomainsPanel.tsx`
- `apps/web/src/lib/api/deployment.ts`
