# Task Tracking System

## When Working on Tasks

1. **Before starting work**: Read the active task file to understand current state
2. **When starting a new task**: Move from `tasks/backlog/` to `tasks/active/`
3. **During work**: Update the task file checklist and notes as you progress
4. **After completing work**: Only move to `tasks/archive/` when the user confirms completion
5. **When creating tasks**: Use `YYYY-MM-DD-descriptive-name.md` naming in `tasks/backlog/`

## Task File Maintenance

- Check off completed items immediately (don't batch)
- Add implementation notes as you discover important context
- Record failures and dead ends so they aren't repeated
- Refer to the task file before each work session to re-orient
- Keep plans detailed enough that you can resume after context loss

## Research Findings Must Become Actionable (Mandatory)

When writing a task file's research/findings section, every finding that identifies a problem or required change MUST result in one of:

1. **A checklist item** in the Implementation Checklist section that addresses it
2. **An explicit deferral** with a backlog task reference (e.g., "Deferred to `tasks/backlog/2026-03-14-fix-xyz.md`")

Findings that exist only in the Research section without a corresponding checklist item or deferral **will be forgotten during implementation**. This is not a theoretical risk — it has caused production bugs. See `docs/notes/2026-03-14-scaleway-node-creation-failure-postmortem.md`.

## Task Completion Validation (Mandatory Before Archive)

Before moving ANY task from `tasks/active/` to `tasks/archive/`, you MUST run the `task-completion-validator` agent (`.claude/agents/task-completion-validator/`). This agent performs five cross-reference checks:

| Check | What it catches |
|-------|----------------|
| **A: Research → Checklist** | Research findings that never became checklist items |
| **B: Checklist → Diff** | Checklist items checked off but not actually in the code changes |
| **C: Criteria → Tests** | Acceptance criteria with no test or manual verification |
| **D: UI → Backend** | UI form fields that collect input but never send it to the API |
| **E: Multi-Resource** | Selection functions that pick from a set without a discriminator |

### Validation Rules

- **CRITICAL/HIGH findings block merge.** Fix them in the branch before merging. Filing a backlog task is NOT an acceptable alternative — the validator exists to catch gaps *before* they ship, not to generate follow-up work. The only exception is explicit human approval to defer a specific finding.
- **A validator FAIL means the task is not complete.** Return to implementation. Do NOT proceed to PR creation or merge.
- **Do NOT rationalize gaps.** "It works when I test it manually" is not an answer to "no test covers this acceptance criterion." Either add the test or document the manual verification with evidence.
- **"Fix or defer" is not a real choice.** If you have time to write a backlog task file, you have time to write the test or fix the gap. The backlog escape hatch has been abused in every case where it was used (PR #568, PR #570) — the follow-up tasks add friction and delay but deliver the same work that should have been done in the original PR.

### When to Run

1. **Before archiving** — always, no exceptions
2. **During PR review** — the `/do` workflow dispatches it automatically in Phase 5
3. **On demand** — use the `task-completion-validator` skill when you want to check progress mid-implementation

## Acceptance Criteria Must Be Testable

When writing acceptance criteria, each criterion must be verifiable by at least one of:
- An automated test (unit, integration, or E2E)
- A documented manual verification with evidence (screenshot, API response, log output)

Criteria like "User with both providers can select which provider to use" require **multi-variant test data** — testing with only one provider present does not verify selection logic.

## Dispatching Tasks to Other Agents

When dispatching a task to another agent (via `dispatch_task` or any other mechanism), the task description MUST instruct the receiving agent to execute the work using the `/do` skill. The `/do` skill is the standard end-to-end workflow for implementing tasks — it handles research, planning, implementation, review, staging verification, and PR creation.

### How to Write Dispatch Descriptions

Include an explicit instruction to use `/do` in the task description. Example:

```
Fix the race condition in workspace cleanup.

Execute this task using the /do skill.
```

The receiving agent will then follow the full `/do` workflow: research, task file creation, worktree setup, implementation, quality checks, specialist review, staging deployment, and PR merge.

### Verify Dispatch Succeeded

After calling `dispatch_task`, wait a few seconds and then check the task status (via `get_task_details` or `list_tasks`) to confirm it was properly dispatched and picked up. The dispatch system can occasionally fail silently — catching this early avoids wasted time waiting for work that never started.

### Why This Matters

Without the `/do` instruction, a dispatched agent may skip critical phases like staging verification, specialist review, or proper PR creation. The `/do` workflow enforces all quality gates defined in this project's rules.

## Integration with Other Systems

- Tasks are for smaller work items; larger features use speckit (`/speckit.*` commands)
- Task files can reference spec files if the work relates to a feature spec
- Constitution validation still applies to all work tracked via tasks
