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

- **CRITICAL/HIGH findings block archive.** Fix them or create explicit backlog tasks.
- **A validator FAIL means the task is not complete.** Return to implementation.
- **Do NOT rationalize gaps.** "It works when I test it manually" is not an answer to "no test covers this acceptance criterion." Either add the test or document the manual verification with evidence.

### When to Run

1. **Before archiving** — always, no exceptions
2. **During PR review** — the `/do` workflow dispatches it automatically in Phase 5
3. **On demand** — use the `task-completion-validator` skill when you want to check progress mid-implementation

## Acceptance Criteria Must Be Testable

When writing acceptance criteria, each criterion must be verifiable by at least one of:
- An automated test (unit, integration, or E2E)
- A documented manual verification with evidence (screenshot, API response, log output)

Criteria like "User with both providers can select which provider to use" require **multi-variant test data** — testing with only one provider present does not verify selection logic.

## Integration with Other Systems

- Tasks are for smaller work items; larger features use speckit (`/speckit.*` commands)
- Task files can reference spec files if the work relates to a feature spec
- Constitution validation still applies to all work tracked via tasks
