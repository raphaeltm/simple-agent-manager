# Agent Memory and Config Audit

## Problem

Review the past two weeks of SAM agent/human interaction, knowledge, ideas, agent profiles, and repo policy files. Update durable memory and instruction surfaces where recurring friction could be prevented by better guidance. Preserve the user's draft-PR constraint.

## Research Findings

- SAM task context requires using the knowledge graph, updating SAM task status, pushing to `sam/workspace-update-01ktnx`, and completing with a summary only after push.
- Existing knowledge and policies already cover several recent lessons: production evidence before speculation, no blind duplicate redispatch, local subagents vs SAM subtasks, staging browser auth, draft/do-not-merge preservation, default profile clutter, CLI quality, and prototype handling.
- Session `169f2f45-04b9-447a-9671-73bbf2d023e0` showed a preventable frustration loop: the agent kept answering a nearby large-node/capacity theory while Raphaël was asking about a specific second medium node card he saw and manually deleted. Backend evidence eventually showed one real medium node, leaving a possible UI/client-state artifact as an unproven hypothesis. The durable instruction gap is exact-symptom preservation before broadening the diagnosis.
- Sessions `285adc24-5acf-4e8b-94fc-7785568d66a0` and `4046451f-22a6-4e52-9930-305cfcfaa30e` showed the secondary-workspace GitHub token regression. Raphaël explicitly rejected a privileged "primary workspace" token-refresh boundary; all running workspaces on a warm-pool node should be treated equally while keeping tokens tightly scoped.
- Idea `01KTN1VGPM7Z3Z4YRHJ0JJJ5YZ` captures the secondary-workspace GitHub token fix and should remain priority 10 until shipped.
- Ideas `01KTK35RWTMAF6ZM169K6TPFPQ` and `01KTJXPRR4NEQXPZHNGAC083GN` are no longer pure designs: task `01KTN6FFAVF9M11GMWYBTZWGPF` reports PR #1256 is draft, CI-green on targeted blockers, labeled `needs-human-review`, and intentionally unmerged. They must not be marked completed before merge.
- No recent evidence justifies editing specific agent profile records. The user's dislike of default profile clutter is already captured as a project policy.

## Implementation Checklist

- [x] Gather local subagent critique and reconcile recommendations before implementation.
- [x] Add exact-symptom debugging guidance to repo instructions without duplicating existing production-debugging rules.
- [x] Update SAM knowledge for the primary-workspace rejection and exact-symptom debugging lesson.
- [x] Append idea hygiene notes to the Codex crash-recovery and secondary-workspace GitHub-token ideas.
- [x] Run lightweight validation for markdown/instruction changes.
- [x] Open a draft PR and do not merge.

## Local Subagent Consensus

Two local critique agents agreed with the proposed direction with these refinements:

- Extend `.claude/rules/39-debug-before-redesign.md`; do not create a new rule file.
- Add only a short AGENTS.md reminder and a small rule 29 cross-reference.
- Do not edit agent profiles without concrete evidence tying a profile setting to the bad outcome.
- Do not mark `01KTK35RWTMAF6ZM169K6TPFPQ` or `01KTJXPRR4NEQXPZHNGAC083GN` completed while PR #1256 is draft/unmerged.
- Keep `01KTN1VGPM7Z3Z4YRHJ0JJJ5YZ` priority 10/open until the secondary-workspace GitHub token regression is shipped.

## Acceptance Criteria

- Future agents have a concrete instruction to answer the exact production/UI symptom before arguing a broader theory.
- Knowledge graph records the explicit no-primary-workspace preference and the exact-symptom debugging lesson.
- Open ideas accurately reflect draft PR / human-gate state without being prematurely completed.
- Agent profiles remain unchanged unless there is concrete evidence for a profile-specific fix.
- Draft PR is pushed on `sam/workspace-update-01ktnx`.
