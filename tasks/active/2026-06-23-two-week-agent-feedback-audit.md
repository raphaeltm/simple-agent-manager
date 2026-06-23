# Two-Week Agent Feedback and Configuration Audit

## Problem

Review the last two weeks of SAM work, agent/human interactions, knowledge, ideas, policies, profiles, and repo agent instructions. Update durable guidance where repeated failures or human corrections show agents need better configuration. Open a draft PR and do not merge.

## Research Findings

- SAM task context requires output branch `sam/workspace-update-01kvsy`, progress reporting through SAM MCP, and durable memory updates when human feedback changes future agent behavior.
- Existing policies already cover many recent failures:
  - Local agents for current-workspace review unless SAM subtasks are explicit.
  - Explicit valid profiles for SAM dispatches.
  - `Backend Implementation` for backend SAM dispatches.
  - `Frontend Implementation` for frontend SAM dispatches.
  - Explicit no-staging instructions override normal staging gates.
  - Read-only status, liveness, and investigation requests stay in-session by default.
  - Failed SAM task retries require inspecting the failed task/session and active duplicates.
  - Draft PR / do-not-merge constraints must be preserved.
- Recent profile correction evidence from June 15 showed Raphaël corrected an Opus implementation dispatch plan and asked for `Backend Implementation`; the existing policy already captures this, so no profile change is needed.
- Recent local-subagent feedback from June 20 explicitly required local PR reviewers to understand the original issue, critique ruthlessly, iterate until satisfied, and not deploy to staging. Existing local-subagent and no-staging policies covered the broad behavior, but not the requirement to pass original issue/evidence into local reviewers.
- Recent failed task lists show duplicate-looking `outputBranch` reuse and failed review-only specialist dispatches around PR #1356. Existing retry guidance mentions prompt/title/branch/PR but should also include `outputBranch` and requested profile/skill/taskMode.
- Existing AGENTS.md/CLAUDE.md/rules already include June 16 guardrails from PR #1185; changes should be narrow and avoid restating all policy content.

## Implementation Checklist

- [x] Add a SAM project policy for local PR critique preserving original issue context and not substituting staging when no-staging is explicit.
- [x] Confirm still-relevant knowledge observations for SAM subtasks vs local subagents, checking ideas/PRs/artifacts, and `/do` requiring push + PR.
- [x] Use local subagents to critique the proposed changes before editing repo guidance.
- [x] Update `AGENTS.md` operational guardrails narrowly for local critique/review wording and outputBranch retry evidence.
- [x] Update `CLAUDE.md` Task Tracking summary with a narrow outputBranch retry note and link to rule 09 for details.
- [x] Update `.claude/rules/09-task-tracking.md` for dispatch verification/retry evidence, including `outputBranch`, requested profile/skill/taskMode, and wrong-context validation handling.
- [x] Update `.claude/rules/02-quality-gates.md` to clarify local vs SAM-dispatched skeptical reviewers.
- [x] Update `.codex/prompts/do.md` local-subagent paragraph to require original issue/evidence/constraints/proposal context and consensus/dissent recording.
- [x] Validate the modified markdown/config references.
- [ ] Open a draft PR and stop without merge.

## Acceptance Criteria

- [x] Durable SAM policy/knowledge updates are complete and non-duplicative.
- [x] Repo guidance points to existing detailed rules where possible instead of duplicating large sections.
- [x] Guidance explicitly distinguishes local subagent critique from SAM-dispatched visible subtasks.
- [x] Failed dispatch retry guidance includes `outputBranch` and requested profile/skill/taskMode evidence.
- [ ] Draft PR describes evidence, durable MCP updates, validation, and no-staging/no-merge handling.

## Validation

- `git diff --check` passed.
- `pnpm install` completed in the clean worktree so repo tools were available.
- `pnpm format:check` was attempted and failed on pre-existing repository-wide formatting drift across 2,297 files.
- Targeted Prettier check on the initially formatted touched files passed, but the formatter introduced broad unrelated markdown churn in instruction files. The formatting-only churn was reverted, and the final diff was kept intentionally narrow.
- Staging was skipped because this branch changes only agent instructions and a task record; there are no runtime code changes to deploy.

## References

- SAM task: `01KVSYRBT6HRZR7ERPT2YD1HT1`
- Output branch: `sam/workspace-update-01kvsy`
- Relevant rules: `.claude/rules/09-task-tracking.md`, `.claude/rules/02-quality-gates.md`, `.claude/rules/38-agent-feedback-and-memory.md`
- Relevant prompt: `.codex/prompts/do.md`
