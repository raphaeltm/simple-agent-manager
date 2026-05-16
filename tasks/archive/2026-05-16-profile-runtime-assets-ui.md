# Profile Runtime Assets UI

## Problem

PR #1037 added backend support for per-profile runtime environment variables and files (API routes, MCP tools, database migration, service layer). However, no UI was built — users cannot configure these from the app. The feature is API/MCP-only, making it useless for non-developer users.

## Research Findings

### Existing Backend
- **API routes**: `GET/POST/DELETE /api/projects/:projectId/agent-profiles/:profileId/runtime/env-vars` and `/files`
- **Response type**: `ProjectRuntimeConfigResponse` — `{ envVars: ProjectRuntimeEnvVarResponse[], files: ProjectRuntimeFileResponse[] }`
- **Env var shape**: `{ key, value (null if secret), isSecret, hasValue, createdAt, updatedAt }`
- **File shape**: `{ path, content (null if secret), isSecret, hasValue, createdAt, updatedAt }`
- **Upsert bodies**: `{ key, value, isSecret? }` for env vars; `{ path, content, isSecret? }` for files

### Existing UI Patterns
- **Project-level runtime config**: `SettingsDrawer.tsx` has inline add/delete for env vars and files — same data shape, same UX pattern
- **Profile management**: `ProfileFormDialog.tsx` handles create/edit in a dialog; `ProfileList.tsx` shows profile cards
- **API client**: `apps/web/src/lib/api/agents.ts` has profile CRUD functions; no profile runtime functions exist yet

### UX Decision
- Runtime assets (env vars, files) are resources that belong to an existing profile — they should only be editable in **edit mode** (not during initial create)
- The `ProfileFormDialog` already has sectioned layout (Agent Settings, Infrastructure) — add a "Runtime Environment" section at the bottom, only visible when editing
- Match the inline add/delete pattern from `SettingsDrawer.tsx` (key/value input → add button → list with delete buttons)
- Secret values show as masked; non-secret values show in full

## Implementation Checklist

- [ ] Add API client functions for profile runtime (get, upsert env var, delete env var, upsert file, delete file) in `apps/web/src/lib/api/agents.ts`
- [ ] Export new functions from `apps/web/src/lib/api/index.ts`
- [ ] Create `ProfileRuntimeSection.tsx` component with:
  - Env vars list with add form (key + value + secret toggle + add button)
  - Files list with add form (path + content textarea + secret toggle + add button)
  - Delete buttons on each item
  - Loading/error states
  - Secret masking (show "****" for secret values)
- [ ] Integrate `ProfileRuntimeSection` into `ProfileFormDialog.tsx` (edit mode only)
- [ ] Verify data path: UI → API client → backend → response updates UI
- [ ] Add unit tests for the new component
- [ ] Run Playwright visual audit (mobile + desktop)

## Acceptance Criteria

- [ ] Users can view existing env vars for a profile (with secrets masked)
- [ ] Users can add new env vars (key, value, optionally mark as secret)
- [ ] Users can delete env vars
- [ ] Users can view existing files for a profile (with secrets masked)
- [ ] Users can add new files (path, content, optionally mark as secret)
- [ ] Users can delete files
- [ ] The section only appears when editing an existing profile (not on create)
- [ ] The UI matches existing patterns (SettingsDrawer env var/file sections)
- [ ] Mobile viewport works without horizontal overflow
