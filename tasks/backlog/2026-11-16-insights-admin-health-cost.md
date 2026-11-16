# Insights slice H: Admin "Health & cost"

SAM task `01M7HTV37AHCYMM53D6ESZWHN2`, coordinator `01M7H0X3PMHK6WT29B1BSSCGWW`, build spec idea
`01M7HTS38KX2G78JD0ESAGMKKH`, channel `feature.insights`. Authorized through production on
2026-11-16.

## Problem

Superadmins have no installation-level view of what compute costs at real node prices, how well
machines are reused and packed, whether lifecycle transitions meet their budgets, or why new
machines were created. The Admin Costs page estimates compute with a flat vCPU-hour rate
(`COMPUTE_VCPU_HOUR_COST_USD`, default $0.003), which ignores the provider prices SAM already
records on every node.

## Research findings

- **Node prices.** `nodes.provider_instance_price_hourly_micros` is set on every managed node
  created in the last 30 days in production (295/295, Hetzner 8,800–47,300, GCP 147k–396k
  micros/h). Node end time for ended statuses is `updated_at` (`getNodeEndedAt`,
  `apps/api/src/services/node-usage-calculation.ts`); the ended set is `ENDED_STATUSES_ARRAY` in
  `node-usage-common.ts`. Cleanup marks rows `deleted` and keeps them; only the explicit user
  delete route removes the row (~10 of 305 nodes in 30 days), so spend is a slight lower bound.
- **Shared nodes once.** Spend is summed per node (node lifetime × node price), never per
  workspace; `compute_usage` is per workspace and would double count shared nodes.
- **Reuse.** The exact record of "this placement used a machine that already existed" is the
  workspace order on its node: a workspace is a new-machine placement when no earlier workspace
  exists on that node (production 30 d: 1,974 reused, 280 first-on-node, against 295 nodes).
  `node_lifecycle_decisions` (`node_lifecycle`/`claimed`/`warm_node_reused`, 72 in 30 d) only
  records warm-pool claims, so it gives the "from the warm pool" part, not the whole rate.
  `placement_explanation_json.diagnostics.selectedNodeId` is rewritten to the new node after
  provisioning, so it cannot tell reuse from creation.
- **Agents per busy machine.** `compute_usage` intervals run creation→deletion (the trap in
  Library `/architecture/capacity-pools/sam-capacity-pools.html` §03). Running intervals come
  from `workspace_resource_summaries` (first to last telemetry sample while the workspace ran);
  2,245 of 2,254 VM workspaces in 30 d have one. Join through `workspaces` to the node
  (`r.node_id` is NULL for 210 rows).
- **Why new machines.** Node rows rarely carry diagnostics (250/295 have no `hosts`), but the
  first workspace on each new node does: `diagnostics.hosts[]` lists the existing machines that
  were refused, each with sanitized reasons from the capacity gate ("Host agent version is
  incompatible", "disk reservation budget would be exceeded", …). Each reason names one
  condition (rule 74). No refused host means there was no other machine to try.
- **Lifecycle latency.** `services/lifecycle-latency/` (#2518): `LIFECYCLE_WATCHES`, `budgetMs`,
  `resolveLifecycleLatencySettings`, `latencyStats`, `classifyRegression` in `daily-evaluation.ts`.
  The daily check reads one query per state (up to 11); the admin page must read all states in
  one windowed query to stay in budget. `lifecycle_state_observations` holds rows currently in a
  watched state (stuck-now count).
- **Watchdog incidents.** The watchdog writes `platform_errors` (`slowStateMessage`), the daily
  check writes `regressionMessage`; hourly triage groups them into `platform_feedback_triages`
  keyed by `sha256("api\n" + normalizeMessage(message))` (`groupPlatformErrors`). Open = queue
  state `pending`/`dispatched`/`claimed`. Each row may link an idea (`idea_id`, a task row with a
  `project_id`).
- **Admin nav** is a flat `Tabs` strip (`apps/web/src/pages/Admin.tsx`); the prototype groups it
  (People, Platform, Spend and health).
- **Operations pattern.** Shared reads live in `packages/operations` and query D1 directly via
  `ctx.env.DATABASE`; worker-owned areas are reached through ports (`ports.ts`,
  `apps/api/src/operation-ports.ts`). Runtime limits are admin settings (rule 07), e.g.
  `inbox-settings-definition.ts`.

## Implementation checklist

- [ ] Shared: move node billing-ended statuses to `packages/shared` and re-export from
      `node-usage-common.ts` (one definition).
- [ ] Shared types `InstallationHealthResponse` + range type.
- [ ] Settings definitions `insights.health*` (max nodes, max placements, max intervals, spend
      weeks) registered in the admin settings registry.
- [ ] `apps/api` lifecycle range report: one windowed episode query, stuck-now observations,
      open incidents by triage signature; reuses `latencyStats`/`classifyRegression`;
      export a signature helper from triage grouping instead of copying it.
- [ ] Port `lifecycleLatency.rangeReport()` in `OperationPorts` + worker implementation.
- [ ] Operation `installationHealth` in `packages/operations/src/insights-installation*.ts`:
      superadmin check, compute spend per provider per week, reuse rate, agents per busy
      machine, new-machine reasons, lifecycle section; section isolation; malformed rows skipped
      with a warn log; ≤ 15 round trips.
- [ ] Route `GET /api/admin/health-cost?range=7d|30d|month` (superadmin).
- [ ] Admin Costs: remove the flat vCPU-hour compute estimate (route, env var, runtime-tunables
      baseline, tests) and point the compute card at Health & cost.
- [ ] Web: grouped admin nav with "Spend and health"; lazy `AdminHealthCost` page with TanStack
      Query, stale-while-revalidate, SAM Glass, prototype layout.
- [ ] Tests: real-SQL op tests (shared node counted once, price × overlap, unpriced, user-owned
      excluded, reuse first-on-node, running intervals vs stopped-undeleted trap, reasons, bad
      JSON row skipped, non-superadmin refused); port test for lifecycle windowed query and
      incident link; route test; web behavioral test; Playwright audit 375/1280.
- [ ] Docs: admin/self-hosting docs mention Health & cost; remove `COMPUTE_VCPU_HOUR_COST_USD`.

## Acceptance criteria

- [ ] Superadmin sees compute spend per provider per week at node prices; a shared node is
      counted once.
- [ ] Reuse rate, agents per busy machine (running intervals), lifecycle p95 vs budget with open
      incidents linked, and new-machine reasons render with real data on staging.
- [ ] Non-superadmins get 403 from the route and are redirected from the page.
- [ ] One malformed row does not fail the page.
- [ ] Route stays within 15 round trips.
- [ ] Admin Costs no longer shows the flat vCPU-hour estimate.
- [ ] Playwright audit at 375 and 1280 with no horizontal overflow.

## References

- Prototype: Library `/product/analytics/analytics-prototypes.html?s=admin`
- Rules 24, 50, 53, 59, 60, 62, 74; apps/api rules 28, 65.
