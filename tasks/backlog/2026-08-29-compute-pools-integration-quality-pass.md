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

- PR #1943 is open/draft, base `main`, head `sam/compute-pools-integration`, and current head is `1f5d9dfe7`.
- The local branch matches `origin/sam/compute-pools-integration`; a sibling worktree is checked out at `/workspaces/sam-compute-pools-integration`.
- The PR diff is too large for `gh pr diff`; local `git diff origin/main...HEAD` must be used for inspection.
- The PR touches backend migrations/schema, capacity-pool/default-pool services, provider catalog metadata, scheduler/provisioning placement, project/user/admin routes, web infrastructure settings, tests, preflight evidence tooling, and task records.
- CodeRabbit review on PR #1943 is `CHANGES_REQUESTED` in GitHub metadata, although current CI checks are green at head. The integration pass must inspect whether the requested changes are already fixed in later commits or still actionable.
- Stored project knowledge and this task require provider-native offering identity: credential/source + provider + region/location + provider instance type/SKU with normalized vCPU/memory/disk/price metadata where available.
- Stored project knowledge and archived placement-resolver task records require centralized scheduler placement resolution across task entry points.
- Public docs still describe small/medium/large workspace sizes. That can remain only as legacy/profile/workspace-size compatibility copy, not pool candidate identity.
- Relevant process lessons/rules: `.claude/rules/09-task-tracking.md`, `.claude/rules/10-e2e-verification.md`, `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/25-review-merge-gate.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/31-migration-safety.md`, `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/44-dual-write-migration-enumerate-writers.md`, `.claude/rules/47-control-loop-io-budget.md`, and `.claude/rules/56-destructive-provider-ownership-proof.md`.
- Relevant task records: `tasks/archive/2026-08-28-concrete-compute-pool-offerings.md`, `tasks/archive/2026-08-28-provider-native-compute-pool-ui.md`, `tasks/archive/2026-08-28-wave-2a-placement-resolver-migration.md`, and `tasks/active/2026-08-28-repair-compute-pool-default-editing.md`.
- Staging evidence exists in PR comments for older PR heads, but this pass must not trigger another staging deploy or claim fresh staging validation.

## Implementation checklist

- [ ] Inspect current PR #1943 metadata, commits, files, CI status, and CodeRabbit comments against the actual branch head.
- [ ] Verify the branch contains backend catalog/reconciliation, scheduler/provisioning, and UI waves together and no later push reverted required earlier behavior.
- [ ] Search actual user-facing UI/copy/tests for compute-pool candidate references to small/medium/large; fix violations while preserving legacy non-pool size copy.
- [ ] Search actual UI for checkbox-based compute-pool candidate management; fix violations.
- [ ] Search actual routing/pages for compute-pool controls on credential pages; fix violations.
- [ ] Search actual UI for hidden-context scope rows such as “Project/User Hidden outside this settings context”; fix violations.
- [ ] Verify backend migrations/schema/shared types/service mappers/routes/default reconciliation/provider interfaces are coherent.
- [ ] Verify default-pool reconciliation preserves user-disabled/deleted offerings and does not silently reactivate removals.
- [ ] Verify scheduler/provisioning consumes concrete offerings through centralized placement resolver and legacy non-pool paths still fall back safely.
- [ ] Verify removed pool offerings exclude future placement/reuse without destroying existing running nodes.
- [ ] Run focused tests for shared capacity types, provider catalogs, default-pool services/routes, placement resolver, task runner/provisioning, workspace placement, and web compute-pool UI.
- [ ] Run repo-level typecheck/lint/build/test as far as practical; document any remaining CI-only or time-bounded validation.
- [ ] Inspect local and PR-linked Playwright screenshot evidence and note whether artifacts are missing or outdated after fixes.
- [ ] Run required specialist reviews for touched areas and address blocking findings.
- [ ] Update PR #1943 body/comment with integration findings, validation results, reviewer evidence, and explicit “no staging deploy performed in this pass.”
- [ ] Push commits to `sam/compute-pools-integration`.

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
