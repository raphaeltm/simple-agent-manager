# Codex token refresh answers a cc-only pinned account with the default's tokens

> **Reconciliation 2026-11-02:** Still present on main (`codex-refresh-lock.ts:667-720`, `:422-428`; `runtime.ts` agent-credential-sync). #2490 (`dedb75591`) made the scope wider. A cc-only **profile** pin (`cc_profile_attachments`) is resolved for the workspace but is invisible to the refresh lock and the sync callback, the same way a #2485 project pin is. The fix must resolve the credential the run actually used, including the profile tier, and the tests should add a profile-pin case. Tracked as idea `01M6CQ607MR1X3TG98NH3E624B`.

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
- [ ] The cc mirror write targets the credential identity captured when the rotation started
      (or runs in the same atomic write as the legacy CAS), never "whichever cc credential is
      the active default now", so a default switch cannot redirect the old account's tokens
- [ ] Tests, through both `CodexRefreshLock` and `agent_credential_sync`: a cc-only Codex pin
      refreshes against its own tokens; the default is unaffected; a default switch during an
      in-flight refresh leaves the new default intact

## Research Findings (2026-11-08, task 01M6WSQF12ENN5G2FFFHXHT59N)

- Boot path: `POST /:id/agent-key` → `getDecryptedAgentKey(db, user, agent, key, projectId, profile)`
  (`services/agent-key-resolution.ts`) with `resolveSessionProfileCredentialContext`. The cc resolver
  order is profile pin → project pin → user default → platform; a Rule 28 halt never falls back to
  legacy. The chosen credential is recorded on `agent_sessions.agent_credential_reference`
  (`cc_credentials:<id>` or `credentials:<id>`) by `persistAgentCredentialAttribution`.
- Refresh path: `routes/codex-refresh.ts` (workspace callback token) → `CodexRefreshLock` DO keyed by
  user. `getStoredCredential` reads only legacy `credentials` (project row, else active user row).
  Write-back: `UPDATE credentials ... WHERE id = ?` (no CAS) + `syncActiveAgentCredentialSecret`,
  which updates "whichever cc credential is the active attachment for the scope now".
- Sync path: `POST /:id/agent-credential-sync` (VM agent `SyncCredential`, payload has no session
  id) has the same legacy lookup and the same scope-based cc mirror.
- Grace-window entries are per-user hashes with no credential identity, so a grace hit returns the
  full token set (including refresh_token) of whatever credential was looked up.
- Staging D1: Codex `agent_sessions` rows carry `cc_credentials:` references on most sessions; some
  are NULL (older rows / platform proxy).
- Exact identity of a stored credential generation across legacy and cc stores is the
  `(encrypted_token, iv)` pair: every dual-write copies the ciphertext verbatim
  (`syncAgentCredentialToCC`, backfill fingerprint, make-default, the lock itself).
- `syncActiveAgentCredentialSecret` has exactly two callers (the lock and the sync route).

## Design

1. One shared target resolver `resolveRunAgentCredentialReferences`
   (`services/composable-credentials/run-credential.ts`): the references recorded by the agent-key
   callback for this workspace's sessions of that agent type; when none are recorded, the same cc
   resolver the agent-key callback uses (`getSelectedAgentCredentialReference` + the workspace's
   profile context). No new resolution logic.
2. `loadRunAgentCredential` reads the referenced row with owner + kind predicates (cc or legacy).
   An inactive row is unusable; nothing ever falls back to the user default.
3. The lock chooses among candidates by possession: stored refresh_token equals the presented one →
   real refresh; else a grace entry bound to that credential reference → full tokens; else a single
   candidate → short-lived tokens only (`stale: true`); several candidates → 401.
4. `writeRotatedAgentCredential`: compare-and-set on the target row's exact old ciphertext, then
   mirror into every other row (legacy or cc, same owner) still holding that exact old ciphertext,
   gated on the primary write having applied. A lost CAS mirrors nothing and logs.
5. Sync route: same resolver and writer; for Codex, a stored account id that differs from the
   synced auth.json account id is refused (never overwrite another account).
6. Remove `syncActiveAgentCredentialSecret` (no remaining callers).

## Implementation Checklist

- [x] Shared resolver + loader + CAS writer (+ Codex auth.json identity parser)
- [x] CodexRefreshLock uses candidates, possession matching, credential-bound grace entries,
      CAS writer; payload carries `credentialReferences`
- [x] codex-refresh route resolves references via the shared resolver
- [x] agent-credential-sync route uses resolver + account-identity guard + CAS writer
- [x] Remove `syncActiveAgentCredentialSecret`; update comments (make-default.ts) and docs
- [x] Real-SQL tests (createSqliteD1 + real encryption): project pin, profile pin, user default,
      legacy rows, inactive pin blocks fallback, no row, mid-refresh default switch (CAS),
      stale response omits refresh_token, grace bound to credential, concurrency exactly-once,
      sync account mismatch; each guard proven discriminating
- [x] Vertical slice: agent-key callback records the pin → refresh rotates the pinned row only
- [ ] Staging: pinned non-default Codex account refresh lands on the pinned credential

## Implementation Notes

- Discrimination proofs (each guard deleted once, `.tmp/discriminate.py`; 94 tests across the DO,
  vertical-slice and make-default files):
  - pre-fix legacy-only lookup → 10 red (profile pin, project pin, stale attack, re-pin, sync cases); legacy-only controls stay green
  - load owner predicate + post-query owner check (both, defence in depth) → forged-reference attack + user-2 owner case red
  - primary CAS ciphertext → default-switch-mid-refresh red
  - mirror gated on primary → lost-CAS mirror test red
  - mirror owner predicate → foreign-user copy test red
  - primary is_active → pin-deactivated-mid-refresh red
  - grace credential binding → both cross-credential grace cases red
  - inactive candidate skip (DO) / sync inactive skip → the two inactive-pin tests red
  - ambiguous-stale guard / possession match → several-candidates-no-proof test red
  - stale omits refresh_token → 8 red (CRITICAL #1 cases)
  - sync account mismatch → account attack red
- Old `configurable-limits` source test passed only because the moved sync handler contained its
  string; repointed at the real messages-route enforcement (`readRequestBodyWithLimit`).
- `routes/workspaces/runtime.ts` shrank 1863 → 1676 by extracting the sync route.
