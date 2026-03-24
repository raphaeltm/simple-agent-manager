# Fix GCP OIDC Deployment Settings UX

## Problem

Four UX issues in the GCP credential/deployment settings UI discovered during feature review.

## Research Findings

### Key Files
- `apps/web/src/components/GcpCredentialForm.tsx` (294 lines) — Cloud provider GCP credential setup flow
- `apps/web/src/components/DeploymentSettings.tsx` (312 lines) — OIDC deployment setup (already well-implemented)
- `apps/web/src/components/ConfirmDialog.tsx` (139 lines) — Existing accessible confirmation dialog
- `apps/web/src/components/project/SettingsDrawer.tsx` (659 lines) — Drawer panel for project settings
- `apps/web/src/pages/SettingsCloudProvider.tsx` — Full settings page with GcpCredentialForm

### Issue Analysis

**Issue 1: No loading state after OAuth redirect (GcpCredentialForm)**
- Line 60: `setPhase('project-select')` immediately on OAuth callback
- Line 93-97: `fetchProjects()` called via useEffect on phase change
- Between render where phase='project-select' and loading=false, user sees empty dropdown
- Fix: Set phase to a loading state first, transition to project-select after fetch

**Issue 2: `phase === 'done'` renders blank/minimal section (GcpCredentialForm)**
- Line 124-126: After setup success, `setPhase('done')` + `onUpdate()` callback
- Line 272-278: Done phase just renders `<Alert>` — no way to return to connected state
- Line 156: Connected state requires `credential && phase === 'idle'` — but phase is 'done'
- Fix: After calling `onUpdate()`, transition phase back to 'idle' so connected state renders when credential arrives

**Issue 3: `window.confirm()` for disconnect (GcpCredentialForm)**
- Line 140: `if (!confirm('Are you sure...')) return;`
- DeploymentSettings already uses ConfirmDialog with accessibility, loading state, and consistent styling
- Fix: Replace with ConfirmDialog component

**Issue 4: SettingsDrawer access**
- DeploymentSettings IS already in SettingsDrawer (line 618)
- GcpCredentialForm is NOT in the drawer — only on full Settings page
- The drawer already has a "Cloud Provider" dropdown for setting default provider
- Fix: No change needed for DeploymentSettings (already there). Could add GcpCredentialForm but it requires credential loading context from SettingsContext which the drawer doesn't have. The drawer already has provider selection. Mark as already addressed.

## Implementation Checklist

- [ ] 1. Fix OAuth redirect loading state in GcpCredentialForm
  - Add a 'loading-projects' phase (like DeploymentSettings has)
  - On OAuth callback, set phase='loading-projects' instead of 'project-select'
  - Trigger fetchProjects from 'loading-projects' phase
  - Show spinner during loading, transition to 'project-select' when done
- [ ] 2. Fix done phase transition in GcpCredentialForm
  - After setup success and `onUpdate()`, also set `phase = 'idle'` so the connected state renders when the credential prop updates
  - Remove the standalone 'done' phase render (or make it a brief success that auto-transitions)
- [ ] 3. Replace window.confirm with ConfirmDialog in GcpCredentialForm
  - Add state: `showDisconnectConfirm`, `disconnecting`
  - Replace `confirm()` call with opening ConfirmDialog
  - Move delete logic into a separate handler called by ConfirmDialog onConfirm
  - Import and render ConfirmDialog with variant="danger"
- [ ] 4. Verify SettingsDrawer already has DeploymentSettings — confirm no additional work needed
- [ ] 5. Add/update tests for changed behavior
- [ ] 6. Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] Loading state shown while GCP projects fetch after OAuth redirect
- [ ] No blank/empty section flicker during the done → connected transition
- [ ] Disconnect uses an in-app confirmation dialog, not `window.confirm()`
- [ ] GCP deployment settings accessible from the SettingsDrawer in chat-first UI (already done)
- [ ] All changes visually tested on mobile (375px) and desktop (1280px) via Playwright
