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
- [ ] Phase 7: Pull Request & Cleanup

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

## Cleanup

Delete `.do-state.md` at the end of Phase 7 (after PR merge and worktree cleanup). It's gitignored, so even if you forget, it won't pollute the repo.

## This Rule Is Non-Negotiable

If you are executing a `/do` workflow and `.do-state.md` does not exist, **stop and create it immediately** before doing anything else. If it does exist, **read it before every phase transition**. There are no exceptions — this is the mechanism that prevents half-completed workflows.
