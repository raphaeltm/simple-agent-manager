# Institutionalize ProjectData Wall-Time Prevention

## Problem

PR #1348 widened the ProjectData Durable Object reconciliation sweep candidate set and exposed a control-loop hazard: the DO `alarm()` handler sequentially awaited VM-agent HTTP calls using the interactive 30s node-agent timeout. Dead nodes consumed the full timeout per candidate, ProjectData DO P99/P999 wall time rose from about 5s to 20-22s with spikes above 40s, and the regression was not detected for about two weeks.

This task delivers the prevention/process/tooling layer from idea `01KWH2QKQHND5WG54FVVZPW577`. The reconciliation code fix itself belongs to task `01KWH5WDKF0ZCY7KGNXFPZNDSD` on branch `sam/fix-projectdata-alarm-wall-01kwh5`.

## Constraints

- Execute via `/do`.
- Use output branch `sam/institutionalize-prevention-measures-projectdata-01kwh6`.
- Do not modify `apps/api/src/durable-objects/project-data/*`, `apps/api/src/services/node-agent.ts`, or `packages/shared/src/constants/reconciliation.ts`.
- Keep changes to rules, docs/checklists, quality tooling, tests, and scheduled workflow automation.
- All thresholds, windows, account IDs, script names, and namespace filters must be env-configurable with `DEFAULT_*` constants where defaults are needed.
- Verify Cloudflare GraphQL Analytics schema from official Cloudflare docs and live introspection before writing the query.

## Research Findings

- Cloudflare Durable Objects metrics docs (last updated 2026-06-29) state DO metrics are exposed through GraphQL datasets including `durableObjectsInvocationsAdaptiveGroups` and tell callers to use GraphQL introspection for dataset fields.
- Live Cloudflare GraphQL introspection on 2026-07-02 confirmed:
  - dataset type `AccountDurableObjectsInvocationsAdaptiveGroups`
  - dimensions include `scriptName`, `namespaceId`, `name`, `type`, `datetime`, `datetimeHour`, and related time buckets
  - quantiles include `wallTimeP99` and `wallTimeP999`
  - filter fields include `datetime_geq`, `datetime_lt`, `scriptName`, `scriptName_in`, `namespaceId`, `namespaceId_in`, `name`, and `name_in`
- Existing quality scripts live in `scripts/quality/`, use `tsx`, expose pure exported logic for Vitest, and use `CF_TOKEN`/`CF_ACCOUNT_ID` for Cloudflare API access.
- The PR template already contains a validation section, staging gate, post-mortem section, specialist review evidence, and agent preflight block.
- Rules 43, 45, and 46 use focused incident lessons plus hard requirements and quick compliance checks; rule 47 should follow that style and cross-link instead of duplicating them.
- Related archived incident/task records:
  - `tasks/archive/2026-05-15-fix-task-reconciliation-heartbeat-alarm-starvation.md`
  - `tasks/archive/2026-05-13-task-reconciliation-checkin.md`

## Implementation Checklist

- [x] Add `.claude/rules/47-control-loop-io-budget.md` covering wall-time budgets, tiered timeouts, zombie prevention, reviewer questions, and incident citations.
- [x] Add the selection-widening load-review checklist item to `.github/pull_request_template.md`.
- [x] Add a short quality-gates pointer to rule 47 in `.claude/rules/02-quality-gates.md`.
- [x] Implement `scripts/quality/check-do-wall-time.ts` with env-configurable windows, thresholds, account/script/namespace filters, Cloudflare GraphQL query, comparison logic, clear exit codes, and no hardcoded IDs.
- [x] Expose the script as `pnpm quality:do-wall-time`.
- [x] Add unit tests for regression, no-regression, and empty/missing-data cases using realistic GraphQL response payload shapes.
- [x] Add a daily scheduled GitHub Actions workflow that runs the wall-time check and visibly fails on regression.
- [x] Run the script against Cloudflare with the available `CF_TOKEN`/`CF_ACCOUNT_ID` and record the output as PR evidence.
- [ ] Run targeted quality-script tests and relevant repo checks.
- [ ] Run required specialist reviews and address findings.

## Acceptance Criteria

- Future alarm/cron/sweep changes have a clear rule for synchronous work, network calls, tiered timeouts, and candidate escape paths.
- Selection-widening PRs must state candidate volume and worst-case per-candidate cost.
- `pnpm quality:do-wall-time` detects a P99 wall-time regression by comparing a recent window to a baseline window with env-configurable thresholds and filters.
- Scheduled CI runs the check daily and surfaces regressions visibly.
- Tests prove regression detection, non-regression behavior, and empty/missing data does not false-positive.
- Cloudflare schema verification and live-script output are included as PR evidence.
