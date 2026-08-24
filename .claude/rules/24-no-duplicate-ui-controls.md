# No Duplicate Implementations

## Rule: Each Operation Must Have Exactly One Implementation

Before adding any new UI control, helper function, service, config resolver, or
data-fetching hook, you MUST search for existing implementations. If a duplicate
is found, consolidate into one canonical location and remove the other.

This rule covers the full stack — UI controls, backend helpers, and everything
between. See rule 59 for the broader system-awareness requirements.

### Why This Rule Exists

PR #558 added a `ScalingSettings` component with a provider dropdown that managed `project.defaultProvider`. The pre-existing "Default Cloud Provider" toggle-button section in `ProjectSettings.tsx` already managed the same field. Both were visible on the same page, using different interaction patterns, and out of sync until page reload. See the retained incident lesson in this rule.

The same class of bug has occurred in backend code: three OAuth helpers each
independently calling `resolvePlatformConfig()`, producing 39 redundant D1
queries per authenticated request.

### Required Steps When Adding UI Controls

1. **Identify the API field(s)** your new control will read/write (e.g., `defaultProvider`, `nodeIdleTimeoutMs`)
2. **Search for existing controls** that manage the same field:
   ```bash
   grep -r "defaultProvider\|setDefaultProvider" apps/web/src/ --include='*.tsx'
   ```
3. **If a duplicate exists**, decide which location is canonical and remove the other
4. **If moving a control**, ensure all related state, handlers, and effects are also moved or cleaned up — no orphaned state variables

### Required Steps When Adding Backend Helpers or Services

1. **Search for existing implementations** of the same operation:
   ```bash
   grep -r "resolvePlatformConfig\|getPlatformConfig" apps/api/src/ --include='*.ts'
   ```
2. **Config resolution**: each config/setting must have exactly one resolution
   function. Multiple callers call the same function — they do not each
   implement their own.
3. **Data-fetching hooks**: each API endpoint should be fetched through one
   shared hook or query key in `apps/web/`.
4. **Type definitions**: each domain concept has one canonical type in
   `packages/shared/`. Do not create parallel shapes.

### Quick Compliance Check

Before committing UI form changes:
- [ ] Every new control's API field was searched for existing occurrences in the codebase
- [ ] No two components on the same page manage the same API field
- [ ] Orphaned state variables from removed controls were cleaned up
- [ ] No duplicate controls exist for any field modified in this PR

Before committing backend helpers or services:
- [ ] Searched for existing functions performing the same operation
- [ ] No parallel resolver/helper exists for the same data
- [ ] Type definitions reuse existing shared types where applicable
