# Workspace Profile UI/UX Improvements

## Problem

The UI/UX specialist review of PR #370 (lightweight workspace profile) identified several usability and accessibility issues that should be addressed in a follow-up.

**Discovered by**: UI/UX specialist agent during PR #370 review (completed post-merge).

## Acceptance Criteria

### Medium Priority

- [ ] Rename label "Workspace" to "Workspace Profile" in `TaskSubmitForm` for consistency with Settings UI
- [ ] Add `min-h-14` (56px) touch target height on profile toggle buttons in `SettingsDrawer` for mobile usability

### Low Priority (Accessibility)

- [ ] Add `role="group"` with `aria-labelledby` on button grids in both `SettingsDrawer` and `TaskSubmitForm`
- [ ] Add `aria-describedby` for the "click again to clear" interaction pattern
- [ ] Associate labels programmatically with select elements in `TaskSubmitForm` (pre-existing issue)
