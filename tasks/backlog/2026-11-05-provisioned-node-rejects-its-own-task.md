# Freshly provisioned node rejects the task it was provisioned for (placement spin until timeout)

## Problem

On staging (2026-11-05, task `01M6NV9E2X95M1E1823NPEE6YV`, node `01M6NV9SBFV60S86N10B526B0G`), a
conversation task submitted with `resourceRequirements {minVcpu: 2, minMemoryGb: 3.5, exclusiveNode: true}`
provisioned a cx23 (2 vCPU / 4 GB). Once the node was healthy, every workspace placement attempt failed
with `node_capacity_rejected: measured memory headroom would be exceeded after outstanding reservations`
(`hostMemoryReserveMb: 512`). The TaskRunner logged `task_runner_do.workspace_placement_lost`, went back to
node selection, recovered the same node, and repeated about every 6 seconds (21+ cycles in the log sample)
until `Node provisioning timed out after 15 minutes` failed the task.

Provisioning chose the offering from declared size (4 GB minus the 512 MB reserve is at least 3.5 GB),
but admission checks measured headroom. The two use different accounting, so the request can never
fit the node it created (`.claude/rules/69`, `.claude/rules/74`).

## Context

Found during staging verification of PR #2539 (reliable workspace shutdown). Unrelated to that change:
it involves no capacity code. The cap of 3.5 GB is the documented ceiling in `.claude/rules/09`, so any
dispatch that follows the rule exactly can hit this.

## Acceptance Criteria

- [ ] A node auto-provisioned for a task with `minMemoryGb: X` can admit that task (provisioning and admission use the same headroom accounting, or provisioning picks an offering whose measured headroom fits)
- [ ] The placement-lost loop is bounded: a provisioned node that cannot admit its own task fails fast with a specific reason instead of spinning until the generic 15-minute provisioning timeout
- [ ] Regression test through the real TaskRunner step path with a 4 GB offering and a 3.5 GB request
