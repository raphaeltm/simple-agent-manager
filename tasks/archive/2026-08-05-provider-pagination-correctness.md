# Fix provider pagination correctness

## Problem

R4 findings 1 and 2 identify provider pagination gaps that can make reconciliation or cleanup silently miss resources:

- Hetzner `listVMs` and `listVolumes` read only the first provider response.
- GCP zonal `listVMs` and aggregated numeric lookup/delete read only the first `nextPageToken` page.

The fix must stay narrowly scoped to `packages/providers`, preserve all public Provider interfaces and successful single-page behavior, and add bounded page guards so provider bugs or malformed cursors fail visibly instead of looping or silently truncating.

## Research findings

- `packages/providers/src/hetzner.ts`
  - `listVMs(labels?)` builds the existing `label_selector` filter correctly, but makes one `/servers` request and maps only that page.
  - `listVolumes(config)` builds existing `label_selector` and `location` query parameters correctly, but makes one `/volumes` request and maps only that page.
  - Existing volume methods catch 404 idempotently and use `mapProviderError` for some operations; pagination should not change that behavior.
- `packages/providers/src/gcp.ts`
  - `listVMs(labels?)` builds the existing `labels.sam-managed=true` plus caller label filter, then loops through configured zones, but reads one `instances` page per zone.
  - `findInstanceByIdOrName(idOrName)` first tries direct zonal name lookup; if not found, it performs one aggregated `instances` lookup filtered to `labels.sam-managed=true`. `getVM`, `deleteVM`, `powerOn`, and `powerOff` rely on this helper for numeric-ID paths.
  - GCP `deleteVM(id)` uses `findInstanceByIdOrName` to resolve the zone before deleting by name and polling the operation.
- `packages/providers/src/validation.ts`
  - Current GCP list validators do not surface `nextPageToken`; validation must accept optional token fields without requiring them.
  - Hetzner list validators do not surface provider pagination metadata.
- Existing tests:
  - `packages/providers/tests/unit/hetzner-lifecycle.test.ts` covers single-page `listVMs` and preserved label selector.
  - `packages/providers/tests/unit/volume-operations.test.ts` covers Hetzner volume operations.
  - `packages/providers/tests/unit/gcp.test.ts` covers GCP create/get/delete/list behavior with mocked fetch.
  - Other providers, especially Vultr and DigitalOcean, already include pagination tests and max-page guard patterns useful as local precedent.

## Implementation checklist

- [x] Extend Hetzner list response validation to read optional provider pagination metadata needed to determine whether more pages exist.
- [x] Update Hetzner `listVMs` to follow provider pagination with a bounded max-page guard while preserving existing label filters and single-page response behavior.
- [x] Update Hetzner `listVolumes` to follow provider pagination with a bounded max-page guard while preserving existing label and location filters and single-page response behavior.
- [x] Extend GCP list/aggregated response validation to read optional `nextPageToken`.
- [x] Update GCP zonal `listVMs` to follow `nextPageToken` per zone with bounded guards while preserving existing filters and tolerated 404/503 zone behavior.
- [x] Update GCP aggregated numeric lookup path used by `getVM`/`deleteVM` to follow `nextPageToken` with bounded guards.
- [x] Add tests covering two-page Hetzner server and volume listing, preserved query filters, empty pages, repeated/malformed tokens, max-page guard, and error propagation.
- [x] Add tests covering two-page GCP zonal listing, two-page aggregated lookup and delete-by-numeric-ID, preserved filters, empty pages, repeated/malformed tokens, max-page guard, and error propagation.
- [x] Run focused provider tests, package lint/typecheck/build, and required repository quality gates.
- [x] Run local specialist subagents/review skills with original finding and diff: test-engineer, task-completion-validator, and relevant domain/security reviewers.
- [x] Open one targeted PR on sam/fix-provider-listlookup-pagination-xcw5py and leave it open/unmerged.

## Acceptance criteria

- Hetzner `listVMs` returns resources from later pages and does not silently truncate results.
- Hetzner `listVolumes` returns volumes from later pages and does not silently truncate results.
- GCP zonal `listVMs` follows `nextPageToken` for each configured zone.
- GCP numeric-ID lookup used by `getVM` and `deleteVM` follows aggregated `nextPageToken`.
- Pagination is bounded and fails clearly for repeated/malformed tokens or page-count exhaustion.
- Existing single-page behavior, filters, labels, locations, returned data formats, public interfaces, defaults, and compatibility are preserved.
- Tests prove the required two-page, empty-page, filter-preservation, guard, malformed/repeated token, and error propagation scenarios.
- Specialist review evidence, tests, staging decision/evidence, CI status, PR URL, head SHA, and open/unmerged state are recorded.

## Completion evidence

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1744
- Head SHA: 915bd5dcc35adb3aea0a3e136fb19a2bf12e8f1a before evidence/archive commit; follow-up archive commit intentionally records final evidence only.
- Branch: sam/fix-provider-listlookup-pagination-xcw5py
- Local focused tests: pnpm --filter @simple-agent-manager/providers test -- tests/unit/hetzner-lifecycle.test.ts tests/unit/volume-operations.test.ts tests/unit/gcp.test.ts passed, 3 files / 83 tests.
- Provider package gates: pnpm --filter @simple-agent-manager/providers lint, typecheck, test, build passed; provider tests passed, 30 files / 533 tests.
- Full local gates: pnpm lint, pnpm typecheck, pnpm test, pnpm build passed. First full test run had a transient unrelated web unhandled timer error; rerun of pnpm --filter @simple-agent-manager/web test passed, then build passed.
- Staging: Deploy Staging run 30997582250 passed, including Cloudflare deploy, D1 backup/migration/data-integrity checks, API/web deploy, binary uploads, Health Check, and smoke-tests.
- PR CI: initial run passed build, lint, typecheck, test, code quality, specialist evidence, UI compliance, durable object workers, Pulumi infra tests, deploy script validation, VM agent smoke, benchmarks, and SonarCloud; preflight required a fresh event after PR body evidence correction.
- Review evidence: test-engineer PASS; provider-domain-reviewer PASS; security-auditor PASS; constitution-validator PASS; task-completion-validator technical findings addressed, procedural PR/staging evidence added here.
- State: PR 1744 is draft/open and intentionally unmerged.
