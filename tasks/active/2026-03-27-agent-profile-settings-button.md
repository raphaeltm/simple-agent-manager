# Agent Profile Settings Button

## Problem

When a user selects an agent profile in the ChatInput, the three individual dropdowns (Agent Type, Workspace Profile, Task Mode) remain visible and don't reflect the profile's values. The user wants a cleaner UX:

- **No profile selected**: Show the usual three dropdowns (agent type, workspace profile, task mode)
- **Profile selected**: Hide the three dropdowns. Show a settings cog button that opens ProfileFormDialog to edit the selected profile inline.

## Research Findings

### Key Files
- `apps/web/src/pages/ProjectChat.tsx` — ChatInput component (lines 1173-1450+) contains both mobile and desktop dropdown layouts
- `apps/web/src/components/agent-profiles/ProfileSelector.tsx` — Profile dropdown selector
- `apps/web/src/components/agent-profiles/ProfileFormDialog.tsx` — Already exists, handles create/edit
- `apps/web/src/hooks/useAgentProfiles.ts` — Hook with CRUD operations including `updateProfile`
- `apps/web/src/components/task/TaskSubmitForm.tsx` — Also has profile selector + VM/workspace dropdowns

### Current Behavior
1. `ChatInput` always renders ProfileSelector AND the three dropdowns (agent type, workspace profile, task mode)
2. `onProfileChange` is just `setSelectedProfileId` — no logic to show/hide dropdowns
3. `handleSubmit` sends both `agentProfileId` AND individual dropdown values; the API uses precedence: explicit field > profile > project default
4. The backend already resolves profiles correctly — the issue is purely UI

### What Needs to Change
1. **ChatInput**: When `selectedProfileId` is set, hide the agent type / workspace / task mode dropdowns
2. **ChatInput**: When profile selected, show a cog button that opens `ProfileFormDialog` to edit that profile
3. **ChatInput** needs access to the profiles array to find the selected profile object for editing, plus `updateProfile` from the hook
4. **TaskSubmitForm**: Same pattern — hide VM size / workspace dropdowns when profile selected, show edit cog
5. **handleSubmit**: When profile is selected, don't send the individual dropdown values (let the backend use the profile's values)
6. Remove the override capability — profile settings ARE the settings when selected

## Implementation Checklist

- [ ] 1. Update `ChatInput` props to accept `onUpdateProfile` callback and pass it from ProjectChat
- [ ] 2. In `ChatInput`, conditionally render dropdowns: hide agent type, workspace profile, and task mode when `selectedProfileId` is set
- [ ] 3. Add a cog (Settings icon) button next to the ProfileSelector when a profile is selected, that opens ProfileFormDialog
- [ ] 4. Wire ProfileFormDialog in ChatInput to call `onUpdateProfile` on save
- [ ] 5. Update `TaskSubmitForm` with the same pattern: hide VM size/workspace dropdowns when profile selected, show cog button
- [ ] 6. Update `handleSubmit` in ProjectChat to omit individual fields when profile is selected (let backend use profile values)
- [ ] 7. Update `handleFork` similarly
- [ ] 8. Update tests for ChatInput/TaskSubmitForm behavior changes
- [ ] 9. Run typecheck, lint, test, build

## Acceptance Criteria

- [ ] When no profile is selected, the three dropdowns (agent type, workspace, task mode) are visible as before
- [ ] When a profile IS selected, the three dropdowns are hidden
- [ ] A cog/settings button appears next to the profile selector when a profile is selected
- [ ] Clicking the cog opens ProfileFormDialog pre-filled with the selected profile's values
- [ ] Saving changes in the dialog updates the profile via API
- [ ] Task submission with a profile selected only sends `agentProfileId` (not individual override fields)
- [ ] Same behavior in both mobile and desktop views
- [ ] TaskSubmitForm follows the same pattern
