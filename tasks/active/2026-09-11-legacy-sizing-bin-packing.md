# Legacy sizing bin-packing follow-up

## Context

Parent session: `76c74d95-4316-4c7b-be8f-8ed1fdfabcbe`  
Parent task: `01M27RVQDA90YMA2NGBJ2YVR58`  
Sizing follow-up noted in parent handoff: `01M28CM31AW1VHE29PWZ9YWH16`

Legacy `small` / `medium` / `large` workload reservations were still sized close to whole provider classes. With the default 512 MiB host memory reserve, the old `medium` and `large` reservations left no practical room for node reuse, causing SAM to provision a VM per agent instead of bin-packing compatible work.

A first plan that tried to make every legacy size fit three same-size tenants was rejected by Fable in task `01M28RT6K998JTJYV0V85ZYHZ3` because placement is resource-only and balanced ranking picks the tightest eligible offering. Shrinking medium/large enough for three tenants would make them eligible for the lower provider class.

Fable approved the revised plan in task `01M28SCFYR159DG0XXQG25BZ49`.

## Approved plan

- Keep provider capacities unchanged.
- Keep placement resource-only: no provider SKU, region, machine-type pinning, and no legacy size eligibility or ranking rule.
- Change only `DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS` and bump `LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION` from `1` to `2`.
- Use these compatibility workload slices:
  - `small`: 0.625 vCPU, 1.125 GiB memory, 13 GiB disk, `maxCoTenants: 3`; three fit on a 2 vCPU / 4 GiB / 40 GiB class after the 512 MiB host reserve.
  - `medium`: 2 vCPU, 3.625 GiB memory, 40 GiB disk, `maxCoTenants: 2`; two fit on a 4 vCPU / 8 GiB / 80 GiB class, and 3712 MiB excludes 4 GiB classes after reserve.
  - `large`: 4 vCPU, 7.625 GiB memory, 80 GiB disk, `maxCoTenants: 2`; two fit on an 8 vCPU / 16 GiB / 160 GiB class, and 7808 MiB excludes 8 GiB classes after reserve.
- Update public docs to describe legacy labels as compatibility workload slices, not provider hardware.

## Implementation checklist

- [x] Update shared legacy workload requirements and adapter version.
- [x] Add shared tests for exact v2 reservation units and provenance.
- [x] Add API admission tests proving the target same-size densities and lower-class reserve exclusions.
- [x] Add placement/default-pool tests proving balanced resource-only selection excludes lower classes before ranking.
- [x] Update public docs that discuss legacy sizing semantics.
- [x] Run targeted shared/API/docs validation.
- [x] Run specialist review checks.
- [ ] Open PR, run CI/CodeRabbit, validate staging with minimal VM usage after prerequisite PRs land.

## Acceptance criteria

- Legacy small resolves to 625 mCPU, 1152 MiB memory, 13312 MiB disk, and max 3 co-tenants.
- Legacy medium resolves to 2000 mCPU, 3712 MiB memory, 40960 MiB disk, and max 2 co-tenants.
- Legacy large resolves to 4000 mCPU, 7808 MiB memory, 81920 MiB disk, and max 2 co-tenants.
- The adapter version stored in compatibility provenance is `2`.
- Admission accepts the final fitting tenant for the target density and rejects the next tenant.
- Candidate filtering excludes medium from 4 GiB classes and large from 8 GiB classes after the default host reserve.
- Docs no longer imply legacy labels are provider hardware.

## Validation log

- `pnpm --filter @simple-agent-manager/shared test -- tests/unit/resource-defaults.test.ts` — passed, 32 tests.
- `pnpm --filter @simple-agent-manager/shared build` — passed.
- `pnpm --filter @simple-agent-manager/providers build` — passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/workspace-resource-capacity.test.ts tests/unit/services/default-capacity-pools.test.ts` — passed, 121 tests.
- `pnpm --filter @simple-agent-manager/www build` — passed, 199 pages built.
- `pnpm check:fast` — passed. Existing lint warnings were outside the touched files; type-boundary audit reported zero blocking findings.

## Specialist review log

- Cloudflare specialist review — PASS. Scope touches API tests and capacity selection behavior, with no wrangler, D1 migration, KV, or R2 configuration changes. The default-pool test uses the existing in-memory D1 test harness and realistic capacity-pool rows.
- Constitution validator — PASS. New hardcoded numeric values are versioned default compatibility mapping data with existing override paths, not deployment-specific URLs, secrets, timeouts, or unconfigurable limits. The adapter version is persisted protocol/provenance metadata.
- Test engineer — PASS. Added shared unit coverage for exact adapter v2 units/provenance, API unit coverage for final admission density and lower-class exclusion, and default capacity-pool coverage for resource-only candidate filtering before balanced ranking.
- Doc sync validator — PASS. Public docs now describe legacy labels as compatibility workload slices and no longer claim the label is provider hardware; documented examples match the code's v2 small/medium/large mapping.
- Task completion validator — PASS for implementation scope. The task file's completed implementation checklist items are all represented in the diff and validated by tests. PR, staging, and production rollout remain intentionally unchecked until the PR gates complete.
