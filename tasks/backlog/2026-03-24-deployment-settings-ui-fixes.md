# Deployment Settings UI Quality Fixes

## Problem

The UI/UX specialist review of the DeploymentSettings component (from PR #499) identified 6 issues where the component deviates from design system patterns and accessibility standards. Four of five rubric categories scored below the threshold of 4.

## Context

Discovered during Phase 5 review of PR #499 (project-level GCP OIDC). The review agent completed after the PR was already merged, so these fixes need a follow-up PR.

## Implementation Checklist

- [ ] **Fix 1 — Use `API_URL` from `api.ts`**: Remove local `API_URL` re-declaration in `DeploymentSettings.tsx` line 14 and import from `../lib/api`. The local version uses `|| ''` fallback which bypasses the production guard in `api.ts`.

- [ ] **Fix 2 — Replace `bg-green-500` with semantic token**: Change the green status dot (line 159) from `bg-green-500` to `bg-success` to match `GcpCredentialForm.tsx` which uses `bg-success-tint` / `text-success-fg`.

- [ ] **Fix 3 — Use shared `Select` component**: Replace raw `<select>` element (lines 203-214) with `<Select>` from `@simple-agent-manager/ui`. Fixes touch target (36px → 44px) and token compliance.

- [ ] **Fix 4 — Replace `window.confirm()` with inline confirmation**: The Disconnect button uses `window.confirm()` which is blocked in PWAs/webviews and can't be styled. Replace with inline confirmation pattern (like project deletion in `ProjectSettings.tsx`) or use shared `Dialog` component.

- [ ] **Fix 5 — Add empty state for zero GCP projects**: When `gcpProjects.length === 0` and `phase === 'project-select'`, render explanatory message ("No GCP projects found for this account") instead of empty dropdown.

- [ ] **Fix 6 — Add `sr-only` text for connected status dot**: Add `<span className="sr-only">Connected</span>` adjacent to the green dot for screen reader accessibility.

## Acceptance Criteria

- [ ] All 6 fixes applied
- [ ] No horizontal overflow on mobile (375px)
- [ ] Playwright visual audit passes for all existing scenarios
- [ ] Shared `Select` component touch target >= 44px on mobile
- [ ] Screen reader can identify connected/disconnected state

## References

- Component: `apps/web/src/components/DeploymentSettings.tsx`
- Shared Select: `packages/ui/src/components/Select.tsx`
- Shared Dialog: `packages/ui/src/components/Dialog.tsx`
- Semantic tokens: `packages/ui/src/tokens/semantic-tokens.ts`
- Existing pattern: `apps/web/src/components/GcpCredentialForm.tsx`
- Playwright tests: `apps/web/tests/playwright/deployment-settings-audit.spec.ts`
