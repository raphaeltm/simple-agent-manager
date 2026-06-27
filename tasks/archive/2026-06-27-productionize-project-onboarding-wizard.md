# Productionize Project Onboarding Wizard

## Problem
PR #1233 (branch `sam/productionize-project-onboarding-prototype-01ktev`) implements a guided 3-step project-onboarding wizard to replace the flat `ProjectForm` at `/projects/new`. It was created 2026-06-06 and is now 273 commits behind main. The wizard needs to be rebased, updated for current APIs/schemas, tested, and shipped.

## Research Findings

### Current State
- **PR branch**: Has `ProjectOnboardingWizard.tsx` (870 lines) with 3 steps (Connect → Setup → Kickoff)
- **Main**: Still uses flat `ProjectForm.tsx` in `ProjectCreate.tsx`
- **ProjectForm** is only imported by `ProjectCreate.tsx` — safe to delete once wizard replaces it
- **Main has gained**: ThemeProvider, deployment pages, settings restructuring, artifacts provider, new admin pages since PR was created
- **Conflict areas**: `App.tsx` (many new routes/imports), `ProjectCreate.tsx` (artifacts support added on main)

### API Endpoint Verification (against main)
- `POST /api/projects` → `apps/api/src/routes/projects/crud.ts` — still present, `CreateProjectSchema` validated
- `POST /api/projects/:id/agent-profiles` → `apps/api/src/routes/agent-profiles.ts` — still present
- `POST /api/projects/:id/triggers` → `apps/api/src/routes/triggers/crud.ts` — still present
- `POST /api/projects/:id/tasks/submit` → `apps/api/src/routes/tasks/crud.ts` — still present
- `GET /api/agents` → `listAgents()` with `configured` field — still present
- GitHub API client (`apps/web/src/lib/api/github.ts`) — still present

### Key Constraints from Idea (01KTEQTH0E2VYRBP6MK3QK6HJ1)
- **X1**: `cronExpression` required client-side for cron triggers; trigger `name` unique per project (409 handling)
- **X2**: `githubCliPolicy` only sent with `mode === 'custom'`; omit for inherit/default
- **X3**: Enabled agents from `GET /api/agents` filtered to `configured === true`
- **G1**: Cascade cleanup automatic on project delete
- **G2**: Two distinct 403 paths — not-approved vs no-credentials
- **G3**: Both task AND conversation kickoff require cloud credentials
- **G4**: Project creation 409 on duplicate name, repository, or githubRepoId — handle inline
- Skills excluded from onboarding

### Distinction from Account Onboarding
This is the PROJECT-CREATION wizard at `/projects/new`. The separate account/platform onboarding wizard (`OnboardingContext/OnboardingChecklist` in `apps/web/src/components/onboarding/choose-path/`) is a distinct system. Do NOT merge or duplicate them.

## Implementation Checklist

- [x] Create worktree from main, port wizard code from PR branch
- [x] Wire `ProjectOnboardingWizard` into `ProjectCreate.tsx` replacing `ProjectForm`
- [x] Delete `ProjectForm.tsx` (dead code after wizard replaces it)
- [x] Remove any `/prototype/project-onboarding` route/dir remnants
- [x] Verify all API client functions exist and match current schemas
- [x] Handle no-credentials 403 distinctly from not-approved 403 (G2/G3)
- [x] Handle 409 conflicts inline for project creation (G4)
- [x] Ensure agents list uses `GET /api/agents` with `configured === true` (X3)
- [x] Require `cronExpression` client-side for cron triggers (X1)
- [x] Send `githubCliPolicy` only for custom mode (X2)
- [x] Keep skills excluded from onboarding UI
- [x] Update force-push to PR branch to update PR #1233
- [ ] Fix Preflight Evidence CI check in PR template
- [x] Write behavioral render+interact tests for wizard
- [x] Write vertical-slice tests for each cross-boundary step (behavioral tests cover full flow connect→setup→kickoff with API mocks)
- [x] Write capability test for full happy path (28 behavioral tests including step progression and error paths)
- [x] Playwright visual audit at 375px + 1280px with stress mock data
- [ ] Fix known test caveat (project-library.test.tsx sr-only duplicate) — pre-existing on main, not caused by this PR

## Acceptance Criteria

- [x] `/projects/new` is the guided 3-step wizard; no second parallel create path exists
- [x] Step 1 creates a real GitHub-backed project with `installationId` and branch
- [x] Step 2 optionally creates profiles and cron trigger; each skippable
- [x] Step 3 submits task/conversation and lands user in live session; skip opens project
- [x] No-cloud-credentials state handled gracefully (no raw 403)
- [x] Enabled-agents list from real agent settings, not hardcoded
- [x] Prototype route/dir deleted; no `/prototype/*` remains
- [x] Tests pass; Playwright audit clean at both viewports
- [ ] Staging verified end-to-end

## References
- Idea: `01KTEQTH0E2VYRBP6MK3QK6HJ1`
- PR: #1233
- Key files: `apps/web/src/components/project-onboarding/ProjectOnboardingWizard.tsx`, `apps/web/src/pages/ProjectCreate.tsx`
