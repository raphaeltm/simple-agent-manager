# Codex token refresh answers a cc-only pinned account with the default's tokens

## Problem

`CodexRefreshLock.getStoredCredential` (`apps/api/src/durable-objects/codex-refresh-lock.ts`)
finds the stored Codex auth.json only in the legacy `credentials` table: the project-scoped
row, else the active user-scoped row. Since #2485 an existing account can be pinned to a
project through `POST /api/cc/attachments` alone, which writes no legacy project row.

A workspace in that project is seeded with the pinned account's auth.json (cc resolution),
but its refresh falls back to the user-scoped legacy row, which holds the default account.
The refresh tokens differ, so the lock takes the stale path and returns the **default
account's** access token to the pinned workspace. The workspace then runs on, and bills,
the wrong Codex account until it restarts. `agent_credential_sync` in
`routes/workspaces/runtime.ts` has the same lookup and would overwrite the default's legacy
row with the pinned account's refreshed auth.json.

Related race: the lock reads the legacy row, awaits OpenAI, then writes the rotation back by
row id with no compare-and-set. If the user replaces or switches the default
(`saveAgentCredentialForUser`, `makeAgentAccountDefault`) inside that window, the late write
overwrites the new default's legacy row and mirrors the old account's token into the new
default's `cc_credentials` row. Writers of that legacy row outside the lock today: Connections
save/replace (`saveAgentCredentialForUser`) and Make default (`makeAgentAccountDefault`).

## Context

Found while adding "Make default" for agent accounts (`makeAgentAccountDefault` in
`apps/api/src/services/composable-credentials/make-default.ts`). That change keeps the legacy
user row in step with the default, so it does not cause or fix this.

## Acceptance Criteria

- [ ] The refresh lock and `agent_credential_sync` resolve the credential a workspace actually
      runs on (the cc resolver's answer for its project), not the legacy default
- [ ] A rotation is written back with a compare-and-set on the value read, and a lost CAS
      skips the cc mirror and logs (no token material)
- [ ] Tests: cc-only Codex pin refreshes against its own tokens; the default is unaffected;
      a default switch during an in-flight refresh leaves the new default intact
