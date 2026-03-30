# No Duplicate UI Controls

## Rule: Each API Field Must Have Exactly One UI Control

Before adding any new form field, settings control, dropdown, toggle, or input that reads or writes an API field, you MUST search the codebase for existing controls that manage the same field. If a duplicate is found, consolidate into one canonical location and remove the other.

### Why This Rule Exists

PR #558 added a `ScalingSettings` component with a provider dropdown that managed `project.defaultProvider`. The pre-existing "Default Cloud Provider" toggle-button section in `ProjectSettings.tsx` already managed the same field. Both were visible on the same page, using different interaction patterns, and out of sync until page reload. See `docs/notes/2026-03-30-duplicate-settings-controls-postmortem.md`.

### Required Steps When Adding UI Controls

1. **Identify the API field(s)** your new control will read/write (e.g., `defaultProvider`, `nodeIdleTimeoutMs`)
2. **Search for existing controls** that manage the same field:
   ```bash
   grep -r "defaultProvider\|setDefaultProvider" apps/web/src/ --include='*.tsx'
   ```
3. **If a duplicate exists**, decide which location is canonical and remove the other
4. **If moving a control**, ensure all related state, handlers, and effects are also moved or cleaned up — no orphaned state variables

### Quick Compliance Check

Before committing UI form changes:
- [ ] Every new control's API field was searched for existing occurrences in the codebase
- [ ] No two components on the same page manage the same API field
- [ ] Orphaned state variables from removed controls were cleaned up
- [ ] No duplicate controls exist for any field modified in this PR
