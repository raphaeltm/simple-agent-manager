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
- [ ] Migration: add `project_id TEXT` column to `credentials` (nullable, FK to `projects.id ON DELETE CASCADE`)
- [ ] Drop and recreate unique index: `(user_id, project_id, agent_type, credential_kind) WHERE credential_type='agent-api-key'` — must treat `NULL project_id` as a distinct value (sqlite does this by default)
- [ ] Drop and recreate active index: include `project_id`
- [ ] Backfill: existing rows keep `project_id = NULL` (user-scoped)

### Resolution logic
- [ ] Update `apps/api/src/routes/workspaces/runtime.ts` agent-settings callback: when fetching credential for a workspace, first query `WHERE project_id = workspace.project_id`, fall back to `WHERE project_id IS NULL`
- [ ] Audit all `credentials` reads: `agents-catalog.ts`, `codex-refresh-lock.ts`, credential sync-back path, OAuth refresh paths
- [ ] Codex refresh proxy: when syncing back rotated tokens, update the **same row** (project-scoped vs user-scoped) — do not silently collapse to user-scoped

### API routes
- [ ] `POST /api/credentials` accepts optional `projectId` body field; server verifies the project belongs to the authenticated user before persisting
- [ ] `GET /api/credentials` supports `?projectId=X` filter; returns both project-scoped and user-scoped for a given project when requested (marked with scope field)
- [ ] `DELETE /api/credentials/:id` preserves scope
- [ ] `POST /api/projects/:id/credentials` nested route as ergonomic alias (optional)

### UI
- [ ] New `ProjectCredentialsSection` on Project Settings page (below `ProjectAgentDefaultsSection`)
- [ ] Per-agent-type card showing user-level credential status + "Set project-specific credential" button
- [ ] Re-use `CredentialForm` component (currently in Settings → Agent Credentials) with a `projectId` prop
- [ ] Clear override button → deletes the project-scoped row, falls back to user-level
- [ ] Visual indicator: "using project credential" vs "inheriting user credential"

### Security / validation
- [ ] Ownership check at every write: `project.userId === auth.userId`
- [ ] Ownership check on read: user can only see credentials where `userId = auth.userId` (project-scoped or not)
- [ ] Audit log: `credential.created`, `credential.deleted`, `credential.rotated` events include `projectId` when set
- [ ] Test: user A cannot set a credential on user B's project (403)
- [ ] Test: user A's project credential is invisible to user B even if they somehow know the project ID

### Tests
- [ ] Unit: resolution order (project > user > platform > null)
- [ ] Unit: OAuth token rotation preserves scope
- [ ] Integration: full task submit with project credential — VM agent receives the project-scoped key, not the user-scoped one
- [ ] Integration: clear project credential → VM agent receives user-scoped key on next session
- [ ] Negative: secondary user attempt to write to primary's project returns 403

### Docs
- [ ] Update `docs/architecture/credential-security.md` with the project-scope tier
- [ ] Update `docs/guides/self-hosting.md` if anything changes for self-hosters (probably nothing)
- [ ] Changelog entry

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
