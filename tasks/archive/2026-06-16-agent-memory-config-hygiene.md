# Agent Memory and Config Hygiene Review

## Problem Statement

Review the past two weeks of SAM work and interaction failures, then update durable agent-facing state so future agents avoid repeated friction. The requested deliverable is a draft PR only; do not merge.

## Research Findings

- SAM MCP task `01KV7Y0Q3SGD21JPPYCFBQ38BG` returned output branch `sam/workspace-update-01kv7y` and required progress updates plus final completion after push.
- Recent SAM tasks show repeated short liveness prompts (`Hello?`, `Can you hear me?`) becoming failed task/branch artifacts. These should normally be answered in-session and not spawn durable work unless the user asks.
- Recent failed read-only/status tasks include open-PR/status/app-deployment context requests that should not create branches or PRs by default. Existing policy already says read-only investigation stays in-session; repo instructions should cross-reference that more clearly.
- Recent retries around alternative inference provider and credential work show duplicate failed tasks sharing branches/prompts. Existing policy and `.claude/rules/09-task-tracking.md` cover verification, but the retry/dedupe path can be made more operational.
- Composable credentials implementation ideas are stale now that related implementation and rollback-fix PRs landed. Idea state should distinguish merged work from still-open follow-up UX/provider-config work.
- App-deployment MVP T ideas have task completions and branch commits but appear to remain on unmerged feature branches; per rule 38, append branch evidence rather than marking completed unless merged/shipped.
- Local subagent critique is required before implementation. Reviewer outputs and consensus must be recorded before editing instruction files.

## Local Subagent Critique Consensus

- Copernicus and Zeno agreed on the core plan: keep `AGENTS.md` as a short cross-reference, put durable behavior in `.claude/rules`, and avoid broad policy churn.
- Both reviewers warned that idea completion requires actual merged/shipped evidence. PR references are enough only when the PR is merged to the intended branch and covers the idea's acceptance surface.
- The retry/dedupe guidance should extend `.claude/rules/09-task-tracking.md` without replacing existing dispatch verification. Missing details to add: inspect failed attempts, compare active duplicates, cite task IDs, verify profile/branch/constraints, and recommend/perform duplicate cleanup only when authorized and available.
- The z.ai/OpenCode idea should remain open because PR #1322 covers backend alternative provider support, not the full user-facing provider-configuration UX.
- App-deploy MVP T ideas should remain open unless the branch merges; append branch evidence if known.
- Meitner timed out before returning; no conflicting critique was received.

## Implementation Checklist

- [x] Gather local subagent critiques for proposed policy/config/idea updates.
- [x] Reconcile critique and record consensus in this task file.
- [x] Update repo instruction/config files with narrowly scoped guidance.
- [x] Update stale SAM ideas via MCP with merge/branch evidence.
- [x] Update or confirm knowledge/policies only when evidence shows durable changes.
- [x] Run focused validation for markdown/config-only changes.
- [x] Open a draft PR and stop without merging.

## Acceptance Criteria

- Durable guidance points at existing detailed rules rather than duplicating large sections.
- Updated ideas include concrete evidence such as PR number, branch, task ID, or commit.
- No idea is marked completed solely because work exists on an unmerged branch.
- Existing local `.codex` changes are not included in commits.
- Draft PR is pushed to `sam/workspace-update-01kv7y` and remains unmerged.
- Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/1335

## Durable State Updates

- Updated policies `9d609b7e-4a59-43e6-ad4b-9bc32605b893` and `ffb4a380-c2b9-4fd9-a24e-dd15e017591a`.
- Confirmed knowledge observations `831cda7a-d607-4e66-bda7-16dbbea36121`, `a025e54d-56a6-4c99-a812-973fe58d68b9`, and `e48f92e7-2ce6-44a2-98aa-29654fe6701b`.
- Added knowledge observation `b00e700a-c68b-4d6d-9747-2d7e84b9c0c0` under `IdeaHygiene`.
- Completed ideas `01KV0AGSMP20SZP5CHX38G9M03` and `01KV30DRD0BH2F4GGG1J7C3V1H`.
- Appended maintenance notes to ideas `01KV00XSXMJWWG9SWK6JAJPC6V`, `01KV0RYQZT4D5P6RXW03`, `01KV0RZ3NWDMV65WT9C7DZAJQJ`, `01KV0RZRAGERJ732BWCVEWBYD7`, `01KV0S05SNEE4AEERRGVS13CD3`, `01KV0S0MDGK5NHE25ZS18SSR0G`, `01KV0S0ZWEZ1XFXQ6NF4XHBDJS`, and `01KV0S1HFWVV3H639CGSCRZDJX`.
