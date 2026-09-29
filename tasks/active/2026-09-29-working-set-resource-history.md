# Working-set memory in session resource history

## Problem

Session resource history records cgroup v2 `memory.current` and `memory.peak`. Both include reclaimable page cache, so file-heavy sessions can appear to require far more RAM than their non-reclaimable workload uses. Sizing consumers need a working-set metric while the existing totals remain available for historical comparison.

## Research findings

- `packages/vm-agent/internal/resourcehistory/collector.go` reads the cgroup counters, writes compressed sample chunks, and computes upload summaries.
- cAdvisor/kubelet-style working set is `memory.current - inactive_file`, clamped to zero. `inactive_file` is read from `memory.stat`; failure to read or parse that file must leave the metric absent.
- `apps/api/src/services/workspace-resource-history.ts` validates upload summaries, stores aggregate columns in `workspace_resource_summaries`, serves raw chunk detail from R2, and downsamples spike-preserving samples.
- Migration `0169_workspace_resource_history.sql` created the summary table. This change needs an additive migration with nullable columns.
- Summary upserts aggregate multiple chunks. A missing value from an old agent must retain an existing known value, and a known value arriving after unknown chunks must use only the known sample count when computing a mean.
- The session drawer currently calls cache-inclusive `memory.current` “RAM peak” and charts it. The UI needs to lead with working set as memory needed, retain a clearly labelled cache-inclusive figure, and render unknown as an em dash.
- Both the project MCP route and the native SAM session tool spread the service response, so their schemas remain compatible; their descriptions/notes need to define the new fields.
- VM-agent staging validation must delete existing staging nodes before deployment, provision a new node afterward, verify heartbeat and the uploaded working-set values, then remove the test resources.

## Implementation checklist

- [ ] Add strict `memory.stat` parsing and optional working-set samples with realistic Go fixtures.
- [ ] Summarize known working-set samples into mean, peak, and known-sample count fields.
- [ ] Add nullable D1 columns and absence-safe aggregate upsert behavior.
- [ ] Add working-set fields to public API and web client types, detail downsampling, and MCP documentation.
- [ ] Update the drawer cards and timeline labels to distinguish memory needed from cache-inclusive memory.
- [ ] Cover new/old-agent uploads and cross-chunk aggregation in API tests.
- [ ] Update the public guide and API reference.
- [ ] Run focused tests, full quality gates, visual audit, specialist review, staging VM verification, CI, and CodeRabbit.

## Acceptance criteria

- Raw samples include working-set bytes only when both `memory.current` and a valid `inactive_file` value are available; subtraction clamps at zero.
- Missing, unreadable, or malformed `memory.stat` yields unknown working set, never a numeric zero.
- Session summaries expose mean and peak working set while retaining `memory.current` mean/peak and kernel peak.
- Old-agent uploads cannot overwrite a known working-set aggregate or cause an unknown value to display as zero.
- HTTP and MCP reads expose the nullable fields, and the UI calls working set the needed figure while labelling totals as cache-inclusive.
- Unit tests cover realistic `memory.stat`, large page cache, missing file, malformed value, and mixed-version aggregation.
- A fresh staging VM reports a populated, plausible working set; heartbeat and workspace access are verified; staging resources are cleaned up.

## References

- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`
- `packages/vm-agent/.claude/rules/27-vm-agent-staging-refresh.md`
- `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`
- `apps/api/.claude/rules/31-migration-safety.md`
- `apps/web/.claude/rules/17-ui-visual-testing.md`
- `tasks/archive/2026-09-20-workspace-resource-history.md`
