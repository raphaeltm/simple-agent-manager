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

## When to Use Tasks vs Speckit

| Use Tasks | Use Speckit |
|-----------|-------------|
| Bug fixes, UI tweaks, small features | New features requiring design artifacts |
| Work described in conversation | Work needing formal spec/plan/tasks pipeline |
| < 1 week of work | Multi-week features |
| No cross-cutting architectural changes | Architectural changes needing ADRs |
