# Fix Duplicate Settings Controls on Project Settings Page

## Problem

The project settings page (`apps/web/src/pages/ProjectSettings.tsx`) has duplicate controls for the same API fields after PR #558 added the `ScalingSettings` component without removing the pre-existing controls.

### Duplicated Fields

| Field | ProjectSettings.tsx | ScalingSettings.tsx |
|-------|-------------------|-------------------|
| `defaultProvider` | Lines 449-487 — toggle-button section "Default Cloud Provider" (shown when 2+ providers configured) | Lines 199-258 — dropdown in "Provider & Location" sub-section |
| `nodeIdleTimeoutMs` | Lines 489-583 — slider in "Compute Lifecycle" section | Lines 286-316 — numeric input in "Node Scheduling" sub-section |

### Non-Duplicated Fields (keep in ProjectSettings)

- `workspaceIdleTimeoutMs` — only in ProjectSettings "Compute Lifecycle" section (not in ScalingSettings)

## Research Findings

- `ScalingSettings.tsx` is the canonical location for provider/location and scaling parameters
- The "Compute Lifecycle" section manages both `workspaceIdleTimeoutMs` and `nodeIdleTimeoutMs` — need to keep the section but remove only the node timeout control
- No existing tests reference the duplicate controls
- Dead code to clean up: `defaultProvider`/`savingProvider`/`configuredProviders` state, `handleSaveProvider` handler, the `listCredentials` import/effect (already done in ScalingSettings), and `nodeIdleTimeoutMs` from the old timeouts section
- The `handleSaveTimeouts` handler currently saves both `workspaceIdleTimeoutMs` and `nodeIdleTimeoutMs` — needs to be simplified to only save `workspaceIdleTimeoutMs`

## Implementation Checklist

- [ ] Remove "Default Cloud Provider" toggle-button section from ProjectSettings.tsx (lines 449-487)
- [ ] Remove `nodeIdleTimeoutMs` slider from "Compute Lifecycle" section (keep `workspaceIdleTimeoutMs`)
- [ ] Rename "Compute Lifecycle" section to "Workspace Idle Timeout" or simplify since it now has only one control
- [ ] Clean up dead state: `defaultProvider`, `savingProvider`, `configuredProviders`, `handleSaveProvider`
- [ ] Clean up dead effects: `listCredentials` import and the effect that fetches configured providers
- [ ] Simplify `handleSaveTimeouts` to only save `workspaceIdleTimeoutMs`
- [ ] Remove `nodeIdleTimeoutMs` state from ProjectSettings sync effect
- [ ] Remove unused imports (`CREDENTIAL_PROVIDERS`, `DEFAULT_NODE_WARM_TIMEOUT_MS`, `MIN_NODE_IDLE_TIMEOUT_MS`, `MAX_NODE_IDLE_TIMEOUT_MS`, `CredentialProvider`)
- [ ] Write post-mortem at `docs/notes/2026-03-30-duplicate-settings-controls-postmortem.md`
- [ ] Add process fix rule at `.claude/rules/24-no-duplicate-ui-controls.md`
- [ ] Verify no tests reference removed controls (confirmed: none do)
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] No duplicate controls exist on the project settings page — each API field is managed by exactly one UI control
- [ ] Post-mortem written at `docs/notes/2026-03-30-duplicate-settings-controls-postmortem.md`
- [ ] New rule added to `.claude/rules/` preventing additive UI duplication
- [ ] Existing tests updated if any reference the removed controls
- [ ] Settings page renders correctly on mobile and desktop after changes

## References

- `apps/web/src/pages/ProjectSettings.tsx`
- `apps/web/src/components/ScalingSettings.tsx`
- `apps/api/src/routes/projects/crud.ts`
- `.claude/rules/17-ui-visual-testing.md`
