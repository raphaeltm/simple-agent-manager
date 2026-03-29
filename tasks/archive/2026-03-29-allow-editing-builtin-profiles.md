# Allow Editing/Deleting Built-in Agent Profiles

## Problem

Built-in agent profiles (default, planner, implementer, reviewer) are seeded per-project but cannot be edited or deleted. Users who want to customize these profiles are blocked by hardcoded guards. The user wants built-in profiles to be fully editable like any user-created profile.

## Research Findings

### Backend guards (to remove)
- `apps/api/src/services/agent-profiles.ts:265-267` — `updateProfile()` throws "Built-in profiles cannot be modified"
- `apps/api/src/services/agent-profiles.ts:334-336` — `deleteProfile()` throws "Built-in profiles cannot be deleted"

### Frontend guards (to remove)
- `apps/web/src/components/agent-profiles/ProfileList.tsx:118` — `{!profile.isBuiltin && (` wraps edit/delete buttons, hiding them for built-in profiles

### Tests to update
- `apps/api/tests/unit/services/agent-profiles.test.ts:466-477` — "rejects updates to built-in profiles" test (remove)
- `apps/api/tests/unit/services/agent-profiles.test.ts:543-551` — "rejects deletion of built-in profiles" test (remove)
- `apps/api/tests/integration/agent-profiles.test.ts:55-58` — source-contract test checking guard strings exist (remove)
- `apps/web/tests/unit/components/agent-profiles.test.tsx:170-178` — "shows edit/delete buttons only for non-builtin profiles" (update to show buttons for all profiles)

### Keep as-is
- `isBuiltin` flag in DB schema and types — still useful for display badge
- `ProfileSelector.tsx:47` — "(built-in)" suffix in dropdown is informational, keep it
- `ProfileList.tsx:100-104` — "built-in" badge display, keep it
- Seeding logic — still seeds defaults on first project access

## Implementation Checklist

- [ ] Remove `isBuiltin` guard from `updateProfile()` in `agent-profiles.ts` service
- [ ] Remove `isBuiltin` guard from `deleteProfile()` in `agent-profiles.ts` service
- [ ] Remove `!profile.isBuiltin` conditional wrapping edit/delete buttons in `ProfileList.tsx` (show buttons for all profiles)
- [ ] Update/remove "rejects updates to built-in profiles" test
- [ ] Update/remove "rejects deletion of built-in profiles" test
- [ ] Update/remove source-contract test for guard strings
- [ ] Add test: built-in profiles can be updated
- [ ] Add test: built-in profiles can be deleted
- [ ] Update frontend test: edit/delete buttons appear for all profiles including built-in

## Acceptance Criteria

- [ ] Users can edit built-in profiles (name, model, system prompt, etc.)
- [ ] Users can delete built-in profiles
- [ ] Built-in badge still displays for informational purposes
- [ ] All existing tests pass (with updated assertions)
