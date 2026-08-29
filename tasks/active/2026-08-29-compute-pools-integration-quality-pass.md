# Compute pools integration quality pass

## Problem statement

PR #1943 is the integration branch for several parallel compute-pools waves. The final pass must inspect the actual branch diff, not task summaries, and fix any remaining product or integration violations before handoff.

Compute pools must be infrastructure-scoped resources backed by concrete provider-native offerings. They must not appear as credential-page controls or expose small/medium/large checkbox candidate identity. Scheduler placement must remain centralized, consume concrete offerings, preserve legacy non-pool fallback behavior, and avoid killing existing nodes when future candidates are removed.

## Constraints

- Target existing branch: `sam/compute-pools-integration`.
- Existing PR: <https://github.com/raphaeltm/simple-agent-manager/pull/1943>.
- Do not deploy to staging.
- Do not merge.
- Push fixes to `sam/compute-pools-integration`.
- Treat prior task summaries as untrusted; use actual branch diff and code evidence.
- Preserve existing running nodes when pool offerings are removed; removals affect only future provisioning/placement.
- Standard `/do` task-file-to-main and new-branch steps are adapted because this task explicitly targets an existing PR branch and forbids merge/deploy.

## Research findings

- PR #1943 is open/draft, base `main`, head `sam/compute-pools-integration`, and the latest pushed integration-pass head is `0c8d56f53`.
- The local branch matches `origin/sam/compute-pools-integration`; a sibling worktree is checked out at `/workspaces/sam-compute-pools-integration`.
- The PR diff is too large for `gh pr diff`; local `git diff origin/main...HEAD` must be used for inspection.
- The PR touches backend migrations/schema, capacity-pool/default-pool services, provider catalog metadata, scheduler/provisioning placement, project/user/admin routes, web infrastructure settings, tests, preflight evidence tooling, and task records.
- CodeRabbit review on PR #1943 is `CHANGES_REQUESTED` in GitHub metadata, although current CI checks are green at head. The integration pass must inspect whether the requested changes are already fixed in later commits or still actionable.
- Stored project knowledge and this task require provider-native offering identity: credential/source + provider + region/location + provider instance type/SKU with normalized vCPU/memory/disk/price metadata where available.
- Stored project knowledge and archived placement-resolver task records require centralized scheduler placement resolution across task entry points.
- Public docs still describe small/medium/large workspace sizes. That can remain only as legacy/profile/workspace-size compatibility copy, not pool candidate identity.
- Product gap found in the integrated branch: removing every candidate disabled the default pool, and active-only summary reads made that owned pool disappear from the editor. The fix keeps scheduler/effective reads active-only while allowing infrastructure editor reads to include disabled owned pools so users can add concrete offerings back.
- Identity-varying user/admin/project capacity-pool responses need `Cache-Control: private, no-store`; project GET/PATCH already had this, while project POST and user/admin default-pool routes did not.
- Centralization gap found in the integrated branch: several task entry points still duplicated capacity selection, credential lookup, attribution, and snapshot logic outside `placement-resolver`. The fix moves task-start capacity/credential/snapshot output into one resolver helper and updates task submit/run, trigger submit, MCP dispatch/orchestration, SAM-session dispatch/retry, and project orchestrator scheduling to consume it.
- Playwright screenshot artifacts were missing locally at the start of this pass. After installing Chromium runtime dependencies, the focused compute-pool/infrastructure audits passed at 375x667 and 1280x800 and generated canonical screenshots under `.tmp/playwright-screenshots/`. Representative normal/edit/empty/error/many screenshots were visually inspected with no compute-pool panel clipping or horizontal overflow found.
- Relevant process lessons/rules: `.claude/rules/09-task-tracking.md`, `.claude/rules/10-e2e-verification.md`, `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/25-review-merge-gate.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/31-migration-safety.md`, `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/44-dual-write-migration-enumerate-writers.md`, `.claude/rules/47-control-loop-io-budget.md`, and `.claude/rules/56-destructive-provider-ownership-proof.md`.
- Relevant task records: `tasks/archive/2026-08-28-concrete-compute-pool-offerings.md`, `tasks/archive/2026-08-28-provider-native-compute-pool-ui.md`, `tasks/archive/2026-08-28-wave-2a-placement-resolver-migration.md`, and `tasks/active/2026-08-28-repair-compute-pool-default-editing.md`.
- Staging evidence exists in PR comments for older PR heads, but this pass must not trigger another staging deploy or claim fresh staging validation.

## Implementation checklist

- [x] Inspect current PR #1943 metadata, commits, files, CI status, and CodeRabbit comments against the actual branch head.
- [x] Verify the branch contains backend catalog/reconciliation, scheduler/provisioning, and UI waves together and no later push reverted required earlier behavior.
- [x] Search actual user-facing UI/copy/tests for compute-pool candidate references to small/medium/large; fix violations while preserving legacy non-pool size copy.
- [x] Search actual UI for checkbox-based compute-pool candidate management; fix violations.
- [x] Search actual routing/pages for compute-pool controls on credential pages; fix violations.
- [x] Search actual UI for hidden-context scope rows such as “Project/User Hidden outside this settings context”; fix violations.
- [x] Verify backend migrations/schema/shared types/service mappers/routes/default reconciliation/provider interfaces are coherent.
- [x] Verify default-pool reconciliation preserves user-disabled/deleted offerings and does not silently reactivate removals.
- [x] Verify scheduler/provisioning consumes concrete offerings through centralized placement resolver and legacy non-pool paths still fall back safely.
- [x] Verify removed pool offerings exclude future placement/reuse without destroying existing running nodes.
- [x] Run focused tests for shared capacity types, provider catalogs, default-pool services/routes, placement resolver, task runner/provisioning, workspace placement, and web compute-pool UI.
- [x] Run repo-level typecheck/lint/build/test as far as practical; document any remaining CI-only or time-bounded validation.
- [x] Inspect local and PR-linked Playwright screenshot evidence and note whether artifacts are missing or outdated after fixes.
- [x] Run required specialist reviews for touched areas and address blocking findings.
- [ ] Update PR #1943 body/comment with integration findings, validation results, reviewer evidence, and explicit “no staging deploy performed in this pass.”
- [x] Push commits to `sam/compute-pools-integration`.

## Validation results

- `pnpm install` passed with an unchanged lockfile.
- Baseline `pnpm typecheck && pnpm lint` passed before fixes.
- Focused API default-pool route/service tests passed: `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/default-capacity-pools.test.ts tests/unit/routes/capacity-pools-defaults.test.ts tests/unit/routes/project-capacity-pools.test.ts`.
- Focused web compute-pool panel tests passed: `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/default-capacity-pools-panel.test.tsx`.
- Focused scheduler/provisioning tests passed after centralizing placement resolution, including task submit/run, MCP dispatch/orchestration, trigger submit, task runner node selection, size fallback, workspace placement, and node-selection integration tests.
- Shared/provider/API seam tests passed for capacity-pool types, provider instance offerings/contracts, provider catalog route, D1 capacity-pool migration, VM admission-control races, and workspace recovery.
- Focused Playwright audit passed after installing Chromium runtime dependencies: `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/default-capacity-pools-scopes-audit.spec.ts tests/playwright/project-settings-subpages-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)" -g "Default capacity pool|Infrastructure sub-page"` — 6 passed.
- Local screenshot artifacts now exist under `.tmp/playwright-screenshots/`; representative mobile/desktop normal/edit/empty/error/many screenshots were visually inspected.
- Full `pnpm lint` passed 13/13 Turbo tasks with existing warning-only diagnostics in `packages/acp-client` and unrelated web files.
- Full `pnpm typecheck` passed 19/19 Turbo tasks.
- Targeted review-fix API suite passed: `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/placement-resolver-fail-closed.test.ts tests/unit/services/nodes-delete.test.ts tests/unit/services/provision-node-rethrow.test.ts tests/unit/resolve-credential-source.test.ts tests/unit/services/provider-credentials.test.ts tests/unit/services/provider-credentials-edge-cases.test.ts tests/unit/routes/providers.test.ts tests/unit/services/trigger-submit-capacity-pools.test.ts tests/unit/task-runner-health-check.test.ts tests/unit/durable-objects/task-runner-readiness.test.ts tests/unit/node-provisioning.test.ts`.
- Provider focused suite passed: `pnpm --filter @simple-agent-manager/providers test -- tests/unit/factory.test.ts tests/unit/hetzner-lifecycle.test.ts tests/unit/volume-operations.test.ts tests/unit/instance-offerings.test.ts tests/contract/provider-contract.test.ts`.
- Web focused suite passed: `pnpm --filter @simple-agent-manager/web test -- tests/unit/lib/compute-pool-offerings.test.ts tests/unit/components/default-capacity-pools-panel.test.tsx`.
- Full `pnpm test` initially exposed stale API mocks in `deployment-provisioning`, `sam-dispatch-lineage`, and `sam-dispatch-task-mode-visibility`; those tests now mock the centralized placement resolver explicitly and the focused rerun passed 3 files / 28 tests.
- Full `pnpm test` passed after the test-harness fix: 21/21 Turbo tasks, including API 630 files / 8549 tests and web 296 files / 3545 tests.
- Full `pnpm build` passed 9/9 Turbo tasks from cache.
- `git diff --check` passed.
- Specialist review findings addressed: Cloudflare exact teardown/provider-catalog cache; security CC project-attachment fail-closed fallback; env/docs missing runtime knobs; constitution hardcoded max-list/freshness-skew values; test vertical-slice/filter coverage; UI screenshot evidence and filter UX.
- Staging deployment/verification was not performed because this task explicitly forbids staging deploys.

## Acceptance criteria

- Compute pools are visible/managed under infrastructure pages/settings for installation, user, and project scopes, not credential pages.
- Pool candidates shown to users are concrete provider-native offerings with provider, location/region, provider instance/SKU, normalized specs, and price metadata where available.
- No user-facing compute-pool candidate UX asks for small/medium/large or checkbox-based size candidates.
- Hidden scope placeholders are not rendered as user-facing rows/cards.
- Backend schema/types/routes/reconciliation/provider interfaces compile and tests cover key integration seams.
- Scheduler/provisioning use concrete offerings through one centralized resolver and preserve legacy non-pool compatibility.
- Removing an offering affects future placement only and does not kill running nodes.
- Focused and high-signal local validation is reported with exact commands/results.
- Playwright screenshot evidence status is reported honestly.
- PR #1943 is updated as appropriate, remains draft/open, is not deployed to staging by this pass, and is not merged.

## References

- PR #1943: <https://github.com/raphaeltm/simple-agent-manager/pull/1943>
- `apps/api/src/services/placement-resolver.ts`
- `apps/api/src/services/placement-resolver-capacity.ts`
- `apps/api/src/services/default-capacity-pools.ts`
- `apps/api/src/services/default-capacity-pool-candidates.ts`
- `apps/api/src/services/default-capacity-pool-updates.ts`
- `apps/api/src/services/capacity-pools.ts`
- `apps/api/src/durable-objects/task-runner/node-selection.ts`
- `apps/api/src/durable-objects/task-runner/node-steps.ts`
- `apps/api/src/services/workspace-placement.ts`
- `apps/api/src/services/nodes.ts`
- `packages/providers/src/instance-offerings.ts`
- `packages/providers/src/types.ts`
- `packages/shared/src/types/capacity-pool.ts`
- `apps/web/src/components/project-settings/DefaultCapacityPoolsPanel.tsx`
- `apps/web/src/components/project-settings/ComputePoolOfferingsManager.tsx`
- `apps/web/src/pages/SettingsInfrastructure.tsx`
- `apps/web/src/pages/AdminInfrastructure.tsx`
- `apps/web/src/pages/ProjectSettings.tsx`
- `.claude/rules/09-task-tracking.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/25-review-merge-gate.md`
