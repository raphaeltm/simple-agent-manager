# Agent History, Memory, and Config Review

## Problem

Review the last two weeks of SAM agent/human interaction, update stale durable memory or ideas, and improve agent-facing config where recent failures show a recurring preventable pattern.

The user explicitly asked for local subagent critique before implementation and authorized merging if consensus is reached.

## Research Findings

- SAM instructions were loaded with `get_instructions`; current task output branch is `sam/workspace-update-01kwy0`.
- Recent failed tasks show repeated `Use the SAM MCP tools (get_session_messages, search_messages) to review the previous session...` failures and stale/generic titles. Existing policy `bb198540...` and rule 09 already cover session-topic alignment and read-only handling; repo guidance should make context-resume tasks bounded and tool-output aware.
- Broad `search_messages` queries can fail with `LIKE or GLOB pattern too complex`. Agents need a fallback: retry narrower terms, read known sessions directly, and reference the existing robustness task instead of stalling or creating duplicates.
- Recent conversation evidence confirms existing policies remain current:
  - Use local subagents when Raphaël asks for local subagents; do not dispatch SAM subtasks.
  - Use explicit profiles for SAM dispatch and verify profile/skill/task mode.
  - Do not treat missing user cloud credentials as a staging/platform provisioning blocker when platform cloud credentials exist.
  - Preserve exact production/UI symptoms and check production evidence before guessing.
- Several draft SAM ideas were checked against merged commit/PR evidence and should be marked complete or updated through SAM MCP:
  - `01KWVH9MBDKPFJNG5E46BSE3VN` chat composer paste/drag/long-text upload has a matching commit `eb1592974`, but it is only on `origin/sam/use-sam-mcp-tools-01kww7`, not `origin/main`; keep open with a maintenance note.
  - `01KWVCX19XE0YKE5T6AQMXJTSD` Codex/display_from_library DocumentCard recognition, merged in PR #1520 and follow-up PR #1524.
  - `01KWQE2VGCWT8FNWTQ0696PYPC` File Preview v2, merged in PR #1508.
  - `01KWKZMB2AQ12AVFJ9VZB7CK4E` full conversation load/timeline jump, merged in PR #1487.
  - `01KWHFG7M50YM8BG19J4B77FR7` morphing completion dock, merged in PR #1474.
  - `01KWF80N3F10K4FEFF61EXEPZS` trigger deletion list affordance, merged in PR #1460.
- Current agent profiles were reviewed. There are multiple custom chat/implementation profiles and no built-in clutter; no profile deletion is justified from the evidence in this review.
- Current active policies were reviewed. They already cover most repeated failures; additions should be narrowly scoped to MCP search robustness and context-resume boundedness rather than duplicating existing rules.

## Local Subagent Critique

Two local reviewers were consulted before implementation:

- Workflow/memory reviewer: PASS with the caveat that ideas must not be blanket-marked completed without reading the idea scope and verifying the merged PR/commit satisfies the whole idea.
- Rule/config reviewer: PASS with changes requested: do not create a duplicate `search_messages` robustness idea because `tasks/backlog/2026-05-06-search-messages-pattern-too-complex.md` already exists; keep detailed guidance in rule 09; keep AGENTS short; skip or minimize CLAUDE.md edits; clarify that session-title updates apply to the current/resumed session unless durable state cleanup is explicitly in scope.

Consensus: proceed with narrow repo instruction updates, update only verified stale ideas, do not change profiles, and reference the existing search robustness backlog task rather than creating a duplicate idea.

## Implementation Checklist

- [x] Ask local subagents to critique the proposed changes before implementation.
- [x] Reconcile subagent feedback and record consensus.
- [x] Update repo instruction/rule files only for evidence-backed recurring issues.
- [x] Complete verified shipped ideas and annotate the non-main branch item without closing it.
- [x] Confirm existing durable knowledge/policies where evidence shows they remain current; do not add duplicates.
- [x] Run focused validation for documentation/config-only changes.
- [ ] Open a PR, verify checks as appropriate, merge if consensus and CI allow.

## Acceptance Criteria

- Recent task/session/policy/profile/idea evidence is reflected in this task file or SAM MCP updates.
- Any new guidance is concise and references existing detailed rules instead of duplicating them.
- Stale ideas are completed or annotated with concrete shipped evidence.
- No unrelated local `.codex/` state from the original checkout is committed.
- Local subagent critique reaches consensus before implementation proceeds.

## Validation

- `git diff --check` passed.
- Final local diff reviewer found two task-record wording issues; both were addressed.
- A local `task-completion-validator` subagent was spawned with the task file and `origin/main...HEAD` diff, but it did not return after three wait windows and was closed. Manual validation against the same A-F checks:
  - A Research -> Checklist: PASS. Each research finding either resulted in rule/AGENTS edits, SAM idea updates, knowledge confirmation, or an explicit no-change decision for profiles.
  - B Checklist -> Diff/Evidence: PASS. Repo edits cover instruction changes; SAM MCP side effects cover idea/knowledge updates.
  - C Criteria -> Verification: PASS. Criteria are covered by task record evidence, local reviewer results, and `git diff --check`.
  - D UI -> Backend: N/A. No UI or API code changed.
  - E Multi-Resource: N/A. No selection logic changed.
  - F Vertical Slice: N/A. No runtime behavior changed.
