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

## Integration with Other Systems

- Tasks are for smaller work items; larger features use speckit (`/speckit.*` commands)
- Task files can reference spec files if the work relates to a feature spec
- Constitution validation still applies to all work tracked via tasks
