# Productionize Project Onboarding Wizard

**Date:** 2026-06-06
**SAM Task:** 01KTEVD7N7M28P5RDJ7M0Y5ZPF
**SAM Idea:** 01KTEQTH0E2VYRBP6MK3QK6HJ1
**Output branch:** sam/productionize-project-onboarding-prototype-01ktev
**Constraint:** Open a DRAFT PR; do NOT merge.

## Problem Statement

The current `/projects/new` route renders a flat `ProjectForm` (`apps/web/src/components/project/ProjectForm.tsx`) that only creates a project — it does not guide the user through configuring agents, triggers, or kicking off their first piece of work. A design prototype (branch `origin/sam/lets-imagine-better-project-01kteg`, never on main) explored a guided 3-step onboarding wizard. This task productionizes that prototype: replace the flat form with a real 3-step wizard wired to live API endpoints, with tests and staging verification.

## 3-Step Wizard Scope

### Step 1 — Connect code
- GitHub repo search/select via `GET /api/github/repositories?installation_id=` (reuse `RepoSelector`).
- Branch via `GET /api/github/branches` (reuse `BranchSelector`).
- Create project via `POST /api/projects` — github path requires `installationId` + `repository` + `defaultBranch`.
- **G4:** handle 409 collisions inline on name / repository / githubRepoId (`projects/crud.ts` returns three distinct conflicts).
- Derive a default project name from repo `owner/repo` → `repo` (prototype `deriveProjectName`).

### Step 2 — Set up (each sub-step individually skippable)
- Create a conversational agent profile via `POST /api/projects/:projectId/agent-profiles`.
- Create a task agent profile via the same endpoint.
- Optional cron trigger via `POST /api/projects/:projectId/triggers`.
- **X3:** Enabled-agents picker MUST read `GET /api/agents` filtered to `configured === true` — NOT agent_settings.
- **X2:** `githubCliPolicy` only sent when `mode === 'custom'`; omit/null otherwise (mirror `ProfileFormDialog.tsx:336`).
- **X1:** Trigger is cron-only in the wizard; `cronExpression` hard-required client-side; handle trigger-name 409.
- Reuse `ModelSelect` for model pickers.

### Step 3 — Kick off
- Both "start a task" and "start a conversation" go through `POST /api/projects/:projectId/tasks/submit` with `taskMode` `'task' | 'conversation'`.
- **G3:** BOTH modes require cloud credentials (credential gate in `tasks/submit.ts` runs before taskMode is read). Surface the credential requirement on both options.
- Always offer "skip — just open the project" → navigate to `/projects/:id`.

## Research Findings (verified)

| ID | Finding | Evidence | Action |
|----|---------|----------|--------|
| X1 | Cron trigger requires cronExpression; trigger-name 409 | `triggers/crud.ts` (cron required, "Trigger ... already exists"); `schema.ts` `idx_triggers_project_name`; `TriggerForm.tsx:238` | Client-side require cron; catch 409 → inline error |
| X2 | githubCliPolicy stored only for `custom` | `services/agent-profiles.ts` `serializeGitHubCliPolicy` returns null on `inherit`; `ProfileFormDialog.tsx:336` | Send policy only when `mode === 'custom'`, else null |
| X3 | Configured agents come from `GET /api/agents`.`configured` | `shared/agents.ts` `AgentInfo.configured`; `listAgents()` | Filter `agents.filter(a => a.configured)` |
| G1 | Triggers cascade on project delete | inline FK `onDelete:'cascade'` `schema.ts:1409` | No extra code needed |
| G2/G3 | Task AND conversation both require cloud credentials | `tasks/submit.ts` credential gate before taskMode | Surface credential requirement on both kickoff options |
| G4 | Project create has 3 distinct 409s | `projects/crud.ts` name / repository / githubRepoId | Map each to inline field error |

### Reusable components
- `ModelSelect.tsx` — agent model picker.
- `ProfileFormDialog.tsx` — reference for profile field set + X2 client pattern.
- `TriggerForm.tsx` / `SchedulePicker.tsx` — reference for cron trigger sub-step.
- `RepoSelector` / `BranchSelector` — reuse in connect step.

### Page wiring
- Replace `apps/web/src/pages/ProjectCreate.tsx` (rendered at `/projects/new` in `App.tsx`).

## Implementation Checklist

- [ ] Build wizard shell component with 3-phase state machine (connect → setup → kickoff) + step indicator.
- [ ] Step 1: ConnectStep — RepoSelector + BranchSelector + name (derived) + create project; handle G4 409s inline.
- [ ] Step 2: SetupWalkthrough with conversational profile, task profile, cron trigger sub-steps, each skippable.
- [ ] Step 2: enabled-agents picker reads `GET /api/agents` filtered `configured === true` (X3).
- [ ] Step 2: githubCliPolicy sent only when `mode === 'custom'` (X2).
- [ ] Step 2: cron trigger requires cronExpression client-side; handle name 409 (X1).
- [ ] Step 3: KickoffStep — task / conversation via `tasks/submit` with taskMode; credential requirement on both (G3); "skip — open project".
- [ ] Replace ProjectCreate page to render the wizard; remove flat ProjectForm usage if now unused.
- [ ] Vertical-slice + behavioral tests (render + interact + assert UI-to-backend data path) per rules 06/35.
- [ ] Playwright visual audit at 375px and 1280px → `.codex/tmp/playwright-screenshots/`.
- [ ] Full quality suite: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- [ ] Staging verification: create-project-then-kickoff flow end-to-end on app.sammy.party.

## Acceptance Criteria

- [ ] `/projects/new` renders the 3-step wizard, not the flat form.
- [ ] A project can be created from a selected GitHub repo + branch; duplicate name/repo/repoId surface clear inline errors (G4).
- [ ] In Step 2, only configured agents appear in the enabled-agents picker (X3); each sub-step is independently skippable.
- [ ] githubCliPolicy is sent only when custom (X2); cron trigger requires a schedule and surfaces name conflicts (X1).
- [ ] Step 3 starts a task or conversation via `tasks/submit`; both surface the cloud-credential requirement (G3); "skip" opens the project.
- [ ] Behavioral tests prove the UI-to-backend data path for project create, profile create, trigger create, and task submit.
- [ ] Playwright audit shows no horizontal overflow at 375px and 1280px.
- [ ] Staging end-to-end create-then-kickoff verified.

## References
- Idea 01KTEQTH0E2VYRBP6MK3QK6HJ1
- Rules: 06 (api patterns / UI-to-backend path), 35 (vertical slice), 17 (visual testing), 13/30/33 (staging), 25 (review gate), 09/14 (task + workflow persistence).
