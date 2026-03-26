# Agent Profiles — Phase 3: UI for Profile Management & Selection

**Created**: 2026-03-15
**Depends on**: Phase 1 (Schema & API)
**Blocks**: Nothing (can be done in parallel with Phase 2)
**Series**: Agent Profiles (3 of 4)

## Problem

Users have no way to create, view, edit, or select agent profiles through the UI. The task submit form has a free-text "Agent hint" field (`TaskSubmitForm.tsx`, `TaskForm.tsx`) that doesn't reference actual profiles.

## Goal

Add UI for managing agent profiles within a project and selecting them when submitting tasks.

## Acceptance Criteria

- [ ] Project settings (or a new "Agent Profiles" section accessible from the project page) shows a list of profiles for the project, including built-in defaults
- [ ] Users can create a new profile: name, description, agent type (dropdown from catalog), model (text input), permission mode (dropdown: default/acceptEdits/plan/bypassPermissions), system prompt append (textarea), timeout minutes, VM size override
- [ ] Users can edit and delete custom profiles (built-in defaults can be edited but not deleted)
- [ ] Task submit form replaces the free-text "Agent hint" with a profile selector dropdown populated from `GET /api/projects/:projectId/agent-profiles`
- [ ] The task submit form still allows "no profile" (uses project/platform defaults)
- [ ] Profile selector shows profile name + agent type + model as context
- [ ] The legacy `TaskForm.tsx` on the project tasks page also gets the profile selector
- [ ] Behavioral tests: render profile management components, simulate create/edit/delete, assert API calls
- [ ] Behavioral tests: render task submit form, simulate profile selection, assert the profile ID is included in the submit payload

## Implementation Notes

- Follow existing UI patterns in `apps/web/src/components/project/` and `apps/web/src/components/task/`
- Use the existing `@simple-agent-manager/ui` design system components (Input, Select, Button, etc.)
- Profile management could live in a drawer/modal accessible from the project page, or as a sub-page under project settings
- The agent type dropdown should be populated from the `GET /api/agents` endpoint (already exists)

## References

- Current task submit form: `apps/web/src/components/task/TaskSubmitForm.tsx`
- Current task form: `apps/web/src/components/project/TaskForm.tsx`
- Agent catalog types: `packages/shared/src/agents.ts`
- Existing settings patterns: `apps/web/src/components/settings/`
