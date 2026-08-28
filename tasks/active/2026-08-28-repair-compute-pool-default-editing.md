# Repair compute pool default editing

## Problem

Raphaël reviewed draft PR #1943 on staging and found two blocking UX gaps:

1. Scope-specific settings pages show placeholder cards for hidden scopes, such as
   “Project — Hidden outside this settings context.” and
   “User — Hidden outside this settings context.” Hidden scopes should not render.
2. Lazy reconciliation creates default compute pools from existing credentials, but the
   generated pool cannot be edited. Owners/admins need to remove or disable unwanted
   provider/region/size candidates, such as Hetzner `ash`/`hil`, while keeping
   `fsn1`/`nbg1`/`hel1`.

## Constraints

- Repair existing draft PR #1943 on `sam/compute-pools-integration` or a child
  branch targeting it.
- Current child branch: `sam/execute-task-using-skill-t4d292`.
- Do not deploy to staging.
- Do not merge.
- Keep PR #1943 draft.
- Preserve v1 precedence: project default → user default → installation default.
- Preserve v1 one-effective-pool semantics; do not build fallback-between-pools UI.
- Preserve centralized placement resolution; do not duplicate scheduler decision logic.
- Do not include unrelated `.codex/config.toml` changes.

## Research findings

- `apps/web/src/components/project-settings/DefaultCapacityPoolsPanel.tsx` renders
  hidden placeholder cards in `ScopeRow`; this directly produces the product-feedback
  symptom. The panel is shared by the project, user, and installation surfaces.
- The shared response contract in `packages/shared/src/types/capacity-pool.ts`
  currently reports `policyMutationSupported: false` and has no mutation payload type.
- Existing API routes only support read/reconcile:
  - `GET/POST /api/projects/:id/capacity-pools/defaults*`
  - `GET/POST /api/capacity-pools/defaults*`
  - `GET/POST /api/admin/capacity-pools/defaults*`
- Existing schema already has `capacity_pools.strategy`,
  `capacity_pools.exhaustion_policy`, `capacity_pools.revision`, and
  `capacity_pool_candidates.status`; no migration is needed for a v1 edit path.
- `ensureCandidatesForSource()` currently sets every existing generated candidate back
  to `active` on reconciliation. That would undo user-disabled or user-deleted
  candidates and must be changed.
- `resolveTaskStartCapacityPoolSelection()` is the centralized scheduler entry point
  for default pool candidates. It should explicitly filter to active candidates so
  disabled/deleted candidates cannot be selected even if a caller passes a broader
  summary.
- Project writes should use `secret:write`, matching existing project credential and
  runtime-resource mutation routes. User default writes are caller-owned. Installation
  default writes remain superadmin-only.
- The existing Playwright audits cover project/user/installation default-pool surfaces
  with stressed data; they need interaction coverage for the edit surface and should
  prove hidden placeholders no longer render.
- Relevant retained lessons:
  - `.claude/rules/24-no-duplicate-ui-controls.md`: add one canonical control for the
    pool policy/candidate fields, not duplicate settings controls.
  - `.claude/rules/35-vertical-slice-testing.md`: route tests should exercise API →
    service → D1 with realistic rows.
  - `tasks/archive/2026-08-28-wave-2a-placement-resolver-migration.md`: placement
    decisions must remain centralized.
  - `tasks/archive/2026-08-28-per-surface-ui-screenshot-evidence.md`: every changed
    UI surface needs desktop and mobile Playwright evidence attached to the PR.

## UI variants considered

1. Inline edit mode inside the existing panel with policy selects and grouped candidate
   status controls.
2. Dedicated modal editor opened from the panel.
3. Separate compute-pool editor subpage.

Selected direction: inline edit mode. It keeps the repair focused, reuses the existing
panel and query/mutation wiring, exposes the changed state in context, and works for all
three surfaces without adding navigation or a second canonical settings location.

## Implementation checklist

- [x] Add shared mutation payload/response types for default pool policy and candidate
      status edits.
- [x] Add an API parser and default-capacity-pool service mutation helper that
      validate policy/status values at the request boundary, scope writes by concrete
      owner, update candidates only inside the owned default pool, increment pool
      revision on real changes, and return the safe response summary.
- [x] Change reconciliation so it inserts new generated candidates as active without
      reactivating existing user-disabled/user-deleted candidates.
- [x] Make placement resolution explicitly ignore non-active candidates.
- [x] Add project/user/admin PATCH routes and API clients for default-pool edits.
- [x] Hide hidden scope rows completely and add meaningful effective-fallback copy.
- [x] Add inline edit mode for the owned default pool, including strategy,
      exhaustion policy, candidate enable/disable, remove, and restore controls grouped
      by provider/region/class.
- [x] Add API/service/scheduler tests proving policy updates, candidate status edits,
      scope ownership, no secret leakage, reconciliation preservation, and scheduler
      exclusion of inactive candidates.
- [x] Add UI component tests proving hidden scopes are omitted and edits reach the
      scope-specific API clients.
- [x] Update Playwright audits for project/user/installation desktop and mobile
      screenshots with stressed editable data and no hidden placeholder cards.
- [x] Run focused tests, typecheck, lint, Playwright visual audits, and relevant
      specialist reviews.
- [ ] Push the child branch and update PR #1943 evidence/comments while keeping it
      draft and unmerged.

## Acceptance criteria

- Hidden scopes do not render as placeholder cards on project, user, or installation
  settings surfaces.
- Project settings show the effective pool and clear fallback explanation when the
  project pool is absent; project edits only target an owned project default pool.
- User settings edit only the authenticated user’s default pool/candidates.
- Admin credentials edit only the installation default pool/candidates.
- Owners/admins can disable/remove/restore provider-region-size candidates, including
  Hetzner `ash`/`hil`, without losing desired candidates such as `fsn1`/`nbg1`/`hel1`.
- Policy edits expose the existing `strategy` and `exhaustionPolicy` fields.
- Reconciliation does not undo user-disabled/user-deleted candidate status.
- Scheduler/placement never selects disabled/deleted candidates and still uses the
  centralized resolver.
- API and UI tests cover the new behavior with realistic state.
- Desktop and mobile Playwright screenshots are captured/reviewed for each changed
  surface and posted/linked on PR #1943.
- No staging deployment, no merge, and PR #1943 remains draft.

## Post-mortem

### What broke

The PR exposed internal scope-visibility state directly in settings UI and omitted an
edit path for reconciled default pools, so users could see irrelevant hidden-scope cards
and could not remove unwanted generated regions or machine candidates.

### Root cause

Wave 3B treated the panel as an inspection-only surface. The API contract had
`policyMutationSupported: false`, and reconciliation owned the full generated candidate
set by resetting existing candidates to `active`. The UI rendered every scope row in the
response, including rows whose purpose was authorization hiding rather than display.

### Timeline

- 2026-08-28: draft integration PR #1943 exposed the default-pool inspection panel and
  staging evidence.
- 2026-08-28: Raphaël inspected staging and reported hidden-scope placeholder cards and
  missing editable generated-candidate controls as blockers.

### Why it was not caught

The existing tests asserted that hidden scope metadata existed in the API response, but
did not assert that hidden rows are omitted from the user-facing page. The UI audit took
screenshots of the read-only summary, not the owner/admin edit workflow.

### Class of bug

Internal authorization/visibility metadata leaked into the product UI, and generated
configuration was treated as system-owned even after users needed to customize it.

### Process fix

Use this task’s component/API/Playwright tests as the concrete process guard for this
PR: UI tests must assert hidden response scopes are not rendered, and visual audits must
exercise the owner/admin edit workflow rather than only the read-only happy path.

## Validation log

- `pnpm --filter @simple-agent-manager/api test -- default-capacity-pools.test.ts capacity-pools-defaults.test.ts project-capacity-pools.test.ts`
  - Passed: 3 files, 26 tests.
- `pnpm --filter @simple-agent-manager/web test -- default-capacity-pools-panel.test.tsx`
  - Passed: 1 file, 9 tests.
- `pnpm typecheck`
  - Passed: 19/19 tasks. Existing Astro template baseline note remained unchanged.
- `pnpm lint`
  - Passed: 13/13 tasks. Existing warning-only ACP/web diagnostics remained unchanged.
- `pnpm quality:file-sizes`
  - Passed after splitting default-pool mutation logic into
    `default-capacity-pool-updates.ts`; no file exceeds the 800-line limit.
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/default-capacity-pools-scopes-audit.spec.ts tests/playwright/project-settings-subpages-audit.spec.ts`
  - Passed: 20/20 tests after installing local Playwright Chromium system dependencies.
  - Screenshots generated under `.codex/tmp/playwright-screenshots/` and
    `.tmp/playwright-screenshots/` for project/user/installation desktop/mobile
    read, edit, and fallback/error stress states.

## Specialist review

- `task-completion-validator`: PASS. The implementation checklist and acceptance
  criteria are covered by the git diff and validation commands, except final push/PR
  comment posting which remains the last operational step.
- `api-reference`: PASS. Added default-pool `PATCH /defaults` routes for user,
  project, and admin scopes using the existing defaults route family and response
  shape.
- `security-auditor`: PASS. Mutations are scoped to authenticated user ownership,
  project `secret:write`, or superadmin installation ownership; candidate IDs are
  resolved inside the owned default pool before update; fallback pools cannot be
  mutated through a narrower scope.
- `test-engineer`: PASS. Added service, route, component, and Playwright coverage
  across persistence, scheduler exclusion, scope permissions, UI payloads, and
  responsive screenshots.
- `ui-ux-specialist`: PASS. Hidden scope placeholders are not rendered, fallback copy
  explains read-only effective pools, and desktop/mobile screenshots cover user,
  project, installation, and project-fallback surfaces.
- `constitution-validator`: PASS. No new hardcoded URLs, environment constants, or
  deployment assumptions were introduced; existing enum/config values are reused.
- `cloudflare-specialist`: PASS. No migration or deployment change required; D1
  writes remain scoped to concrete pool/candidate rows and increment pool revision on
  real changes.
- `doc-sync-validator`: PASS. No public docs surface changed; the task record captures
  the temporary PR repair contract and validation evidence.
- CodeRabbit overlap review:
  - Addressed project capacity-pool cache/editability overlap by keeping
    `Cache-Control: private, no-store` on identity-varying project responses and
    returning `policyMutationSupported` based on `secret:write`.
  - Addressed default-pool reconciliation overlap by batching generated candidate
    upserts while preserving user-edited candidate statuses.
  - Verified existing placement resolver checks already reject provider mismatch and
    explicit-location mismatch before a candidate reaches task-runner DO startup.
  - Verified panel error rendering now suppresses effective/scope cards when no cached
    data exists, and project default-pool screenshots now use `.tmp/`.
