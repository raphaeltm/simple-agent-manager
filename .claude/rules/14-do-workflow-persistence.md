# /do Workflow State Persistence (Anti-Compaction)

## The Problem

During long `/do` executions, context compaction drops earlier phases from the conversation. The agent forgets what phase it's in, which checklist items are done, and what remains. This causes agents to skip phases, repeat work, or lose track of the task entirely.

## Mandatory: Use the State File

When executing the `/do` workflow, you MUST maintain a `.do-state.md` file in the repository root (gitignored). This file is your **external memory** — it survives context compaction because you re-read it.

### Create It at Phase 1 Start

As the very first action when starting a `/do` execution, create `.do-state.md`:

```markdown
# /do Workflow State

## Task
<one-line summary of what you're doing>

## Task File
<path to the task file, e.g., tasks/active/2026-03-14-notification-system.md>

## Branch
<branch name once created>

## Worktree
<worktree path once created>

## Current Phase
Phase 1: Research & Task Creation

## Phase Checklist
- [ ] Phase 1: Research & Task Creation
- [ ] Phase 2: Worktree Setup
- [ ] Phase 3: Implementation
- [ ] Phase 4: Pre-PR Validation
- [ ] Phase 5: Review
- [ ] Phase 6: Staging Verification
- [ ] Phase 7: Pull Request & Post-Merge Deploy Monitoring

## Phase 5: Review Tracker
<populated when Phase 5 starts — one line per dispatched reviewer>
<Phase 5 is NOT complete until every entry shows PASS or ADDRESSED>

## Implementation Progress
<checklist items from the task file, updated as you go>

## Notes
<anything important discovered during execution>
```

### Update It at Every Phase Transition

Before starting any new phase, update `.do-state.md`:
1. Check off the completed phase
2. Update "Current Phase" to the new phase
3. Add any notes about what was accomplished

### Update It During Long Phases

During Phase 3 (Implementation) and Phase 5 (Review), update the file after every significant unit of work — every commit, every test run, every reviewer dispatched.

### Re-Read It Regularly

**CRITICAL**: At the start of every new action, before deciding what to do next, **re-read `.do-state.md`**. This is your ground truth for where you are in the workflow. If your memory of the conversation feels incomplete or fuzzy, the state file tells you what's real.

### Use Plan Mode as a Checkpoint

At the transition between Phase 3 (Implementation) and Phase 4 (Pre-PR Validation), enter Plan Mode briefly to:
1. Re-read the state file
2. Re-read the task file
3. Verify all checklist items are actually done (not just checked off from memory)
4. List what remains before the PR

This forces a deliberate pause that prevents the "rush to PR" failure mode.

## What the State File Prevents

| Failure Mode | How the State File Helps |
|---|---|
| Forgetting which phase you're in | "Current Phase" field is always current |
| Skipping review phase | Checklist shows Phase 5 unchecked |
| Losing track of implementation items | "Implementation Progress" mirrors the task file |
| Forgetting the branch/worktree path | Recorded at creation time |
| Repeating already-done work | Checked items + notes show what's been accomplished |
| Jumping to PR creation early | Phase checklist enforces ordering |
| Merging before reviewers finish | Review Tracker blocks Phase 5 completion until all reviewers report back |
| Silently failing production deploy | Phase 7 checklist includes deploy monitoring — task is not complete until deploy succeeds or user is alerted |

## Cleanup

Delete `.do-state.md` at the end of Phase 7 (after PR merge, deploy monitoring, and worktree cleanup). It's gitignored, so even if you forget, it won't pollute the repo.

## Phase 5 → Phase 6 Transition Guard

Before advancing past Phase 5, you MUST:

1. Re-read `.do-state.md`
2. Check the "Phase 5: Review Tracker" section
3. If ANY reviewer shows `DISPATCHED`, **STOP** — you are not done with Phase 5
4. Wait for the outstanding reviewer(s) to complete, then update their status
5. Only after every reviewer shows `PASS` or `ADDRESSED` may you check off Phase 5

**Why this exists:** PR #409's security auditor was dispatched during Phase 5 but completed after the PR was merged. Context compaction caused the agent to forget it was waiting for a reviewer and advance through Phases 6-7. PR #568 repeated this exact failure — the go-specialist and security-auditor completed post-merge, and their CRITICAL findings were filed as backlog tasks instead of being fixed. See `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`.

### Updating the Review Tracker

When dispatching a reviewer agent, immediately write:
```markdown
- [ ] security-auditor — DISPATCHED (agent-id: <id>)
```

When the reviewer completes with no blockers:
```markdown
- [x] security-auditor — PASS, no critical findings
```

When the reviewer finds issues that you fix:
```markdown
- [x] security-auditor — ADDRESSED, 2 HIGH fixed in commit abc123
```

When the reviewer finds issues deferred to backlog:
```markdown
- [x] security-auditor — DEFERRED, 1 MEDIUM → tasks/backlog/2026-03-16-rate-limiting.md
```

## PR Description Is the Durable Source of Truth

`.do-state.md` is gitignored and lives in the worktree. It is destroyed when the workspace is killed. The PR description, by contrast, is durable — it lives on GitHub and is visible to humans.

**When you create the PR in Phase 7, you MUST copy the Review Tracker into the PR description's "Specialist Review Evidence" table.** This is the authoritative record. If `.do-state.md` is lost (workspace killed, worktree removed), the PR description is what humans will use to verify whether reviews were actually completed.

If you cannot populate the PR's review table because you've lost track of reviewer state (context compaction, workspace killed), you MUST add the `needs-human-review` label and stop. See `.claude/rules/25-review-merge-gate.md`.

## This Rule Is Non-Negotiable

If you are executing a `/do` workflow and `.do-state.md` does not exist, **stop and create it immediately** before doing anything else. If it does exist, **read it before every phase transition**. There are no exceptions — this is the mechanism that prevents half-completed workflows.
