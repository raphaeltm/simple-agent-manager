# Profile Hygiene Follow-up From Two-Week Agent Audit

## Problem

The two-week audit found one current agent-profile configuration that could recreate a known failed interaction:

- Failed SAM task `01KWAAFF331P2A9VZW3MMPSJT6` ("Hello? Is fable available?") failed on 2026-06-29 because the selected model `claude-fable-5` did not exist or the project/user did not have access.
- The project profile `01KWAAE073VEMV9NBHSWA0PQJP` still appeared usable as `Mythos test` with model `claude-fable-5`.

Prior merged instruction work in PR #1426 already covers read-only/liveness requests, duplicate retry evidence, local subagent critique context, and idea hygiene. This follow-up is intentionally narrower: failed experimental model profiles should not remain visible as apparently usable profiles.

## Research Findings

- `get_instructions` returned output branch `sam/workspace-update-01kwbz` and required progress reporting.
- Current profiles showed `Mythos test` using `claude-fable-5`, conversation mode, lightweight workspace.
- `get_task_details(01KWAAFF331P2A9VZW3MMPSJT6)` showed the profile launch failed with: selected model `claude-fable-5` may not exist or access may be missing.
- `find_related_ideas` and `search_knowledge` found no existing Fable/Mythos availability entry to update.
- The separate Codex 429 issue is already captured in idea `01KWBRKQHR5SPVKG7Q09ZFJQ5Y` and PR #1439, so it should not be folded into profile-hygiene guidance.
- Local subagent critique reached PASS for the narrow profile-hygiene change; two earlier broad reviewers stalled and were closed without output.

## Implementation Checklist

- [x] Update the failed `Mythos test` agent profile so it is visibly archived/disabled and no longer points at unavailable `claude-fable-5`.
- [x] Add a narrow SAM project policy for experimental/model-test profiles that fail due to unavailable or inaccessible models.
- [x] Add one concise AGENTS.md guardrail row for this failure mode.
- [x] Add one concise rule 38 periodic-maintenance note so future audits update profile state before retrying.
- [x] Keep existing Codex 429 and OpenCode mismatch ideas separate.
- [x] Validate markdown changes.

## Acceptance Criteria

- [x] Profile `01KWAAE073VEMV9NBHSWA0PQJP` is renamed/described as archived after the 2026-06-29 unavailable-model failure.
- [x] The profile no longer advertises `claude-fable-5` as its launch model.
- [x] Durable project policy records the profile-hygiene rule without duplicating existing retry/read-only guidance.
- [x] Repo guidance is concise and points future maintenance audits at profile state, not just task retry mechanics.
- [x] No runtime code changes or staging deployment are required.

## Validation

- `git diff --check`
- `pnpm exec prettier --check AGENTS.md .claude/rules/38-agent-feedback-and-memory.md tasks/active/2026-06-30-profile-hygiene-audit.md` attempted in the clean worktree, but dependencies were not installed there and `prettier` was unavailable.

## Durable State Updates

- Updated profile `01KWAAE073VEMV9NBHSWA0PQJP` to:
  - name: `Archived - Mythos test (model unavailable 2026-06-29)`
  - description: disabled after `claude-fable-5` launch failure; verify model availability before reuse
  - model: `claude-opus-4-6`
  - effort: `auto`
- Added project policy `f6ae1041-3c72-4cb5-9082-dcedfa745729`: `Archive experimental profiles after unavailable-model failures`.
