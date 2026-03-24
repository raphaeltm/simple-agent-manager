# Fix DeploymentSettings UI Dead Ends and UX Issues

## Problem

When a user completes the Google OAuth flow but their Google account has zero GCP projects, the DeploymentSettings component renders an empty dropdown with a disabled "Set Up Deployment" button and no explanation. Additionally, several related UX issues exist: missing loading state during OAuth project fetch, blank 'done' phase, native `window.confirm()` for disconnect, and the component is missing from the SettingsDrawer.

## Research Findings

### Key Files
- `apps/web/src/components/DeploymentSettings.tsx` — main component (249 lines)
- `apps/web/src/pages/ProjectSettings.tsx` — full settings page that includes DeploymentSettings
- `apps/web/src/components/project/SettingsDrawer.tsx` — drawer overlay for chat-first UI (655 lines)
- `apps/web/src/lib/api.ts` — API client functions

### Current Behavior
1. **Empty state**: When `gcpProjects` returns empty array, the `project-select` phase renders with an empty `<select>` and disabled button. No messaging.
2. **Loading**: After OAuth redirect, `listGcpProjectsForDeploy` fires but UI stays on `phase === 'idle'` showing "Connect Google Cloud" button until projects load.
3. **Done phase**: `handleSetup` sets `phase = 'done'` before `loadDeploymentCred` resolves. No render case for `phase === 'done'`, so UI shows nothing briefly.
4. **Disconnect confirm**: Uses `window.confirm()` on line 115. ProjectSettings uses inline `showDeleteConfirm` state pattern.
5. **SettingsDrawer**: Has no DeploymentSettings section. Only has VM size, workspace profile, provider, runtime config, and project views.

### Patterns to Follow
- **Inline confirmation**: `ProjectSettings.tsx` lines 46-47 use `showDeleteConfirm`/`deleteConfirmText` state with conditional rendering.
- **Spinner**: `@simple-agent-manager/ui` `Spinner` component already imported.
- **Toast**: `useToast()` hook already in use.

## Implementation Checklist

- [ ] 1. Add `loadingProjects` state to show a loading indicator while fetching GCP projects after OAuth redirect
- [ ] 2. Add empty state UI when `gcpProjects.length === 0` after fetch: explanatory message, link to GCP Console, "Try Again" button
- [ ] 3. Fix `phase === 'done'` blank flash: keep `setting-up` phase until `loadDeploymentCred` completes, then go back to `idle`
- [ ] 4. Replace `window.confirm()` with inline confirmation pattern (showDisconnectConfirm state)
- [ ] 5. Add DeploymentSettings section to SettingsDrawer between runtime config and project views
- [ ] 6. Write behavioral tests for DeploymentSettings covering: empty project list, loading state, disconnect confirmation
- [ ] 7. Run lint, typecheck, and tests

## Acceptance Criteria

- [ ] After OAuth with zero GCP projects, user sees explanatory message with GCP Console link and "Try Again" button
- [ ] During project list fetch, user sees a loading indicator (not stale "Connect Google Cloud" button)
- [ ] No blank flash between setup completion and credential display
- [ ] Disconnect uses inline confirmation, not `window.confirm()`
- [ ] DeploymentSettings is accessible from the SettingsDrawer
- [ ] All changes pass lint, typecheck, and tests
