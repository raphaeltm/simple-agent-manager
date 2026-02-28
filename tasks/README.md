# Task Tracking

Lightweight markdown-based task tracking for smaller work items.

## Structure

```
tasks/
├── backlog/    # Tasks waiting to be worked on
├── active/     # Tasks currently in progress
├── archive/    # Completed tasks
└── README.md   # This file
```

## Lifecycle

```
backlog/ → active/ → archive/
```

1. **Backlog**: User describes work → agent creates task file in `backlog/`
2. **Active**: Agent starts work → moves file to `active/`, builds detailed plan + checklists
3. **Archive**: Work complete and confirmed → moves file to `archive/`

## File Format

Files use `YYYY-MM-DD-descriptive-name.md` naming. See `AGENTS.md` for the full template.

## Task Decomposition Rules

When decomposing a feature into multiple tasks:

1. **The last task must be integration verification.** It must test the complete feature end-to-end on staging — not by reading code or running component tests, but by exercising the deployed system with the primary user action and verifying the final outcome.

2. **Cross-cutting concerns must have explicit owners.** If data flows from system A to system B, one task must explicitly own that boundary. Write it out: "Task 3 owns: task description delivery from TaskRunner DO to Claude Code process."

3. **Assumptions about existing behavior must be verified in the first task.** If the work builds on "existing X works," the first task must include a checklist item: "Verified X works end-to-end (test name / manual evidence)."

See `.claude/rules/10-e2e-verification.md` and the post-mortem at `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md` for why these rules exist.

## When to Use Tasks vs Speckit

| Use Tasks | Use Speckit |
|-----------|-------------|
| Bug fixes, UI tweaks, small features | New features requiring design artifacts |
| Work described in conversation | Work needing formal spec/plan/tasks pipeline |
| < 1 week of work | Multi-week features |
| No cross-cutting architectural changes | Architectural changes needing ADRs |
