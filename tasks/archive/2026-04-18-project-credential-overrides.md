# Project-Level Credential Overrides (Multi-Level Config Phase 2)

**Priority:** HIGH (requestor has active need)
**Depends on:** PR #748 (Phase 1 — per-project `model` + `permissionMode`)
**Parent idea:** `01KNKRCS8DSX8FREC02AJV23QH`

## Problem

Today, agent API keys and OAuth tokens live in the `credentials` table scoped by `(userId, agentType, credentialKind)` with a uniqueness constraint. A user can only hold **one active** `ANTHROPIC_API_KEY`, one `CLAUDE_CODE_OAUTH_TOKEN`, one `OPENAI_API_KEY`, etc.

This blocks real use cases:

- Different projects billed to different Anthropic API keys (client A vs client B workspace)
- A Claude Max token for personal projects alongside an API key for work projects
- An Anthropic API key for one project + an Anthropic OAuth token for another

PR #748 added per-project `agentDefaults` for `model` and `permissionMode` but explicitly excluded credentials.

## Goal

Allow a user to override any agent credential (API key or OAuth token) at the **project** level. Resolution chain extends to:

```
Task explicit > project credential override > user credential > platform credential > null (fail)
```

Credentials must remain encrypted (AES-GCM) and never leak across users, even when a user attempts to attach a credential to a project they don't own.

## Design Options

### Option A — Add `projectId` to existing `credentials` table (preferred)

Add nullable `projectId TEXT REFERENCES projects(id) ON DELETE CASCADE`. Update unique indexes to include `projectId` so a user can hold both a project-scoped and a user-scoped credential for the same `agentType + credentialKind`. Resolution picks the most specific match.

**Pros:** single table, shared encryption + rotation code paths, simpler UI.
**Cons:** index migration non-trivial (partial unique indexes on sqlite).

### Option B — Separate `project_credentials` table

Mirror schema but keyed on `projectId + userId + agentType + credentialKind`.

**Pros:** cleaner separation, no migration risk to existing rows.
**Cons:** duplicate encryption/read/write code paths, two sources of truth.

**Recommendation:** Option A. The encryption/OAuth refresh/Codex proxy logic is non-trivial; duplicating it across two tables is a maintenance trap.

## Implementation Checklist

### Data layer
- [x] Migration 0042: add `project_id TEXT` column to `credentials` (nullable, FK to `projects.id ON DELETE CASCADE`)
- [x] Replace single unique index with two partial unique indexes (user-scope WHERE project_id IS NULL, project-scope WHERE project_id IS NOT NULL) — sqlite partial indexes
- [x] Rebuild active index to include `project_id`
- [x] Existing rows keep `project_id = NULL` (user-scoped) — schema-only migration, no backfill needed

### Resolution logic
- [x] `getDecryptedAgentKey(db, userId, agentType, key, projectId?)` resolves project → user → platform in order
- [x] `apps/api/src/routes/workspaces/runtime.ts` agent-key callback fetches `workspace.projectId` and forwards it
- [x] `agent-credential-sync` endpoint preserves scope: looks up project-scoped first, falls back to user-scoped
- [x] `codex-refresh` route forwards `projectId` to the DO
- [x] `CodexRefreshLock` DO queries and updates the correct scoped row on rotation

### API routes
- [x] New `projectCredentialsRoutes`: GET / PUT / DELETE at `/api/projects/:id/credentials(/:agentType/:credentialKind)`
- [x] All guarded by `requireOwnedProject` — cross-user write returns 404
- [x] Response shape: `AgentCredentialInfo` with `scope: 'project'` and `projectId` set
- [x] User-level routes `/api/credentials/agent` unchanged (user-scoped, `project_id IS NULL`)

### UI
- [x] New `ProjectAgentCredentialsSection` on Project Settings page
- [x] Per-agent card reusing `AgentKeyCard` component (existing behavior preserved)
- [x] "Inheriting user credential (...xxxx)" hint when no override exists but user-level does
- [x] "Remove" button on project-scoped credential deletes the override → falls back to user credential
- [x] Info banner explains override semantics

### Security / validation
- [x] Ownership check at every write (`requireOwnedProject`) — returns 404 for non-owned projects
- [x] List/get filters by `userId = auth.userId AND projectId = :id` — isolation at query layer
- [x] Cross-user write test: returns 404 (unit test `project-credentials.test.ts`)
- [x] Credential encryption unchanged (AES-GCM via same `encrypt`/`decrypt` helpers)

### Tests
- [x] Unit: resolution order (project > user > platform > null) — `project-credentials.test.ts`
- [x] Unit: PUT rejects cross-user, DELETE rejects cross-user
- [x] Unit: PUT inserts with `project_id` set, DELETE scoped to project
- [ ] Staging: full task submit with project credential override — verified via Playwright in Phase 6
- [ ] Staging: clear project credential → task uses user-scoped credential

### Docs
- [x] Update `docs/architecture/credential-security.md` with the project-scope tier
- [x] Changelog / CLAUDE.md Recent Changes entry

## Acceptance Criteria

- [ ] A user can set an Anthropic API key on Project A and a different Anthropic API key on Project B
- [ ] A user can set a Claude Max OAuth token on Project A and an API key on Project B (different `credentialKind`)
- [ ] Tasks submitted to Project A use the project-scoped credential; Project B uses its own
- [ ] Clearing a project credential falls back to the user-level credential without requiring workspace restart
- [ ] Cross-user isolation verified on staging with two accounts
- [ ] OAuth token rotation (Codex refresh proxy) updates the correct scoped row

## Scope Boundaries

**In scope:** agent credentials (`credentialType = 'agent-api-key'`) at the project level.

**Out of scope (separate phases):**
- Cloud provider credentials (`credentialType = 'cloud-provider'`) at the project level — already tracked partially via `project_deployment_credentials`; deserves its own task
- Profile-level credential overrides
- Session-level / trigger-level credential overrides (see `2026-04-18-multi-level-override-framework.md`)

## Notes

Requestor explicitly flagged credential overrides as their immediate need (2026-04-18). They currently work around this by swapping their active user-level credential between sessions — not viable for parallel project work.
