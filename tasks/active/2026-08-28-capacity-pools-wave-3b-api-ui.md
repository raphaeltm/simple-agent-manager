# Wave 3B — Default Capacity Pools API and UI

## Context

- Integration base: `sam/compute-pools-integration`
- Output branch: `sam/execute-task-using-skill-t199df`
- Child PR target: `sam/compute-pools-integration`
- Staging: explicitly out of scope for this task

Wave 2B added lazy default capacity pool reconciliation in
`apps/api/src/services/default-capacity-pools.ts`. The service can seed one
effective default pool per scope from existing credentials using
project → user → installation precedence, but there is no backend route or web
surface for humans to inspect the default pool that will be used.

## Research Findings

- Capacity pool schema, safe mapper types, and default-pool reconciliation
  already exist on the integration branch.
- Existing `CapacityPoolSummary` exposes `pool`, `sources`, and an active
  candidate count. Wave 3B needs active candidate metadata in safe response
  types so the UI can show provider, region, runtime, and machine candidates.
- `capacity_sources` stores credential IDs/references/version metadata only;
  encrypted credential tokens live in credential/platform credential tables and
  must not be selected or returned by the new API.
- Project credential metadata routes use
  `requireProjectCapability(..., 'secret:read')`; default pool summaries expose
  credential-derived source metadata, so the project route should follow that
  authorization level.
- Installation/platform credential data is currently superadmin-gated; the new
  response must not expose installation sources to non-superadmins.
- The existing project settings Infrastructure tab is the narrowest UI surface
  for a first-pass default compute pool panel.
- Policy mutation is possible in the schema, but adding update contracts,
  validation, and revision semantics is broader than the minimal inspection
  slice; keep mutation as an explicit follow-up unless implementation remains
  clearly small.

## Implementation Checklist

- [x] Add shared safe API response types for default capacity pool summaries.
- [x] Extend the default-pool service to return active candidate metadata.
- [x] Add project-scoped API routes to read and idempotently reconcile visible
      default pools.
- [x] Gate project route with existing project credential visibility patterns
      and installation summaries with superadmin visibility.
- [x] Add a plain project settings Infrastructure panel showing effective pool,
      precedence, sources, providers/regions/machine candidates, and policy.
- [x] Add deterministic API and UI/component tests.
- [x] Run local validation only; no staging actions.
- [x] Open a child PR against `sam/compute-pools-integration`.

## Acceptance Criteria Mapping

- User/admin can inspect effective default compute pool without reading D1:
  API route and Infrastructure settings panel.
- Lazy default-pool creation is reachable safely: idempotent reconcile route,
  with read route using the same safe summary builder.
- Secrets are not exposed: response selects capacity pool/source/candidate rows
  only and tests assert credential token fields do not appear.
- UI is enough for staging smoke later: component tests plus local Playwright
  audit coverage; staging validation remains explicitly skipped.

## Validation Log

- `pnpm --filter @simple-agent-manager/api test -- project-capacity-pools.test.ts`
  — pass, 6 tests.
- `pnpm --filter @simple-agent-manager/api test -- default-capacity-pools.test.ts capacity-pools.test.ts project-capacity-pools.test.ts`
  — pass, 18 tests.
- `pnpm --filter @simple-agent-manager/web test -- default-capacity-pools-panel.test.tsx`
  — pass, 4 tests.
- `pnpm --filter @simple-agent-manager/shared lint` — pass.
- `pnpm --filter @simple-agent-manager/api lint` — pass.
- `pnpm --filter @simple-agent-manager/web lint` — pass with 3 pre-existing
  warnings in unrelated files.
- `pnpm typecheck` — pass, 19 turbo tasks.
- `pnpm format:check` — pass.
- `pnpm quality:type-boundaries` — pass.
- `pnpm quality:file-sizes` — changed `default-capacity-pools.ts` is under the
  800-line limit after helper split; check still fails on pre-existing unrelated
  `apps/api/src/routes/mcp/orchestration-tools.ts` at 844 lines.
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/project-settings-subpages-audit.spec.ts`
  — blocked before assertions because local Chromium cannot launch:
  `libnspr4.so: cannot open shared object file`. The spec coverage was added for
  later local/CI execution; no staging validation was run.

## Pull Request

- Child PR: <https://github.com/raphaeltm/simple-agent-manager/pull/1950>
