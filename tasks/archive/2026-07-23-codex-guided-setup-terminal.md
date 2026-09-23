# Codex Guided Setup Terminal (Cloudflare Sandbox)

**Idea:** `01KRPWSZWFT0Y06DH9VEXC7CYQ` (status=ready) — read the 2026-07-23 BUILD DECISION section for authoritative scope.
**Reference spike (unmerged):** `sam/weve-previously-talked-setting-01kwwm`; spike doc `tasks/active/2026-07-06-cloudflare-setup-terminal-staging-spike.md`.

## Problem

Connecting an OpenAI Codex (ChatGPT subscription) account to SAM today forces the user to run `codex login` on their own machine, find `~/.codex/auth.json`, and paste the whole file into a textarea. We want a guided flow: click "Connect with Codex", SAM opens a short-lived Cloudflare Sandbox terminal running `codex login --device-auth`, the user signs in with ChatGPT, SAM captures `auth.json` server-side, saves it as an encrypted `openai-codex` oauth-token credential, and tears the sandbox down. Manual paste remains as a fallback.

**Scope: Codex ONLY.** No Claude guided path, no `claude setup-token` capture/blackout, no Claude PTY probe. Claude keeps its existing manual-paste fallback untouched.

**Substrate: Cloudflare Sandbox** (`SANDBOX` DO / `SandboxDO` container). Raw `VmAgentContainer` stays the workspace runtime — do NOT reuse it here.

**HARD CONSTRAINT:** Ships behind a default-off gate (`CODEX_SETUP_TERMINAL_ENABLED`). The live ChatGPT sign-in → capture → save cannot be tested by the agent (needs a human + real OpenAI login). Drive through staging verifying everything up to the human sign-in; open a DRAFT PR + `needs-human-review`; **do NOT merge** — Raphaël runs the live login test.

## Research findings (file:line)

### Sandbox SDK
- `getSandbox(env.SANDBOX, sandboxId)` via wrapper `apps/api/src/services/sandbox.ts:28-32` (dynamic import — SDK absent under Miniflare). DO re-export `apps/api/src/index.ts:20`. Binding `apps/api/src/env.ts:70` `SANDBOX?: DurableObjectNamespace<Sandbox>`. wrangler `apps/api/wrangler.toml:254-266` (container `SandboxDO` standard-1 `max_instances=3`, binding `SANDBOX`, migration v13).
- **`sandbox.terminal(request, {cols,rows}) → Promise<Response>`** — pass `c.req.raw` straight in, return the Response verbatim (SDK DO owns the 101 upgrade; no manual WebSocketPair). Binary xterm frames. Client lib `@cloudflare/sandbox/xterm`.
- `sandbox.exec(cmd,{timeout})→{stdout,stderr,exitCode,success}`; `sandbox.readFile(path)→{content}`; `sandbox.writeFile(path,content)`; `sandbox.exists(path)→{exists}`; `sandbox.destroy()`.
- No session API — implicit default session; env injected inline in the shell command string (`CODEX_HOME=… codex login --device-auth`).
- **Version drift already fixed** (both 0.12.1). **Codex CLI NOT in the image on main** — must add pinned `@openai/codex` to `apps/api/Dockerfile.sandbox` (spike used `@openai/codex@0.142.5`).
- Spike PROVEN: codex 0.142.5 device-auth reached device-code + printed URL+code; terminal 101 + binary xterm proven; concurrency cap hit ("max running container instances exceeded") → one sandbox/user + sub-cap.

### Durable Objects
- Pool atomicity = `ctx.storage.transactionSync(() => {read; check cap; upsert; return})` (TrialCounter `apps/api/src/durable-objects/trial-counter.ts:77-91`), NOT blockConcurrencyWhile (that's constructor init only).
- Session DO: `this.sql = ctx.storage.sql`; constructor `ctx.blockConcurrencyWhile(()=>ctx.storage.transactionSync(()=>runMigrations(this.sql)))`; identity in `do_meta` INSERT OR IGNORE (ProjectData `apps/api/src/durable-objects/project-data/index.ts:43-68`).
- Alarm (NodeLifecycle `apps/api/src/durable-objects/node-lifecycle.ts:214-271,416-431`): on write `ctx.storage.setAlarm(now+ttl)`; `alarm()` re-reads + re-checks expiry, acts, else reschedules retry.
- RPC-first: `env.X.get(env.X.idFromName(id)) as DurableObjectStub<Class>; stub.method(...)`. Wrap in `services/<name>.ts` (mirror `services/node-lifecycle.ts:18-34`). `fetch()` only for WS.
- Registration: re-export `index.ts:2-20`; Env binding `env.ts:52-70`; wrangler binding block + NEW `[[migrations]]` tag after **v17** → v18/v19 `new_sqlite_classes`. A new DO migration file with DDL must be added to `DO_MIGRATION_FILES` in `scripts/quality/check-do-migration-safety.ts:32-47` (or keep DDL append-only regardless).

### JWT / auth / routing
- `apps/api/src/services/jwt.ts:10-15` audiences. Add `CREDENTIAL_SETUP_TERMINAL_AUDIENCE='credential-setup-terminal'`. Copy `signTerminalToken` (:47-72) + `verifyTerminalToken` (:264-287) + `getTerminalTokenExpiry` (:29-32). Keys `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (RS256).
- **WS auth = `?token=` query param** (verified in ws-* proxy `index.ts:347-357`; rationale `jwt.ts:255-263`). Mirror: assert `payload.setupSessionId === :id`.
- Mount `app.route('/api/agent-credential-setup-sessions', routes)` as ordinary top-level group (browser session-cookie auth, NOT a VM callback — rule 34, no pre-projectsRoutes ordering). Per-route `requireAuth(), requireApproved()` (notifications.ts:130-151 pattern); WS route has NO session middleware (verifies `?token=`). `getUserId(c)` `apps/api/src/middleware/auth.ts:199-201`.

### Credential save
- No wrapper today — 4 steps inlined in routes. `CredentialValidator.validateCredential` (`apps/api/src/services/validation.ts:290-347` → `validateOpenAICodexAuthJson:62-120`) → `encrypt(plaintext, getCredentialEncryptionKey(env))` (`apps/api/src/services/encryption.ts:33-58`, `apps/api/src/lib/secrets.ts:24-26`) → legacy `credentials` row write (`apps/api/src/routes/credentials.ts:646-679`) → `syncAgentCredentialToCC(db, {...})` (`apps/api/src/services/composable-credentials/agent-sync.ts:99-172`, REQUIRED dual-write rule 44; maps codex→'auth-json'; SKIPS if isActive=false).
- Canonical routes: `PUT /api/credentials/agent` `apps/api/src/routes/credentials.ts:571-723` (user); `PUT /api/projects/:id/credentials` `apps/api/src/routes/projects/credentials.ts:372-520` (project).
- Gotchas: isActive=false skips cc dual-write → save autoActivate=true; autoActivate deactivates same-scope siblings; vm-agent sync-back uses `syncActiveAgentCredentialSecret` (UPDATE-only) — do NOT use for first-time save.

### Frontend
- `apps/web/src/components/AgentKeyCard.tsx` Codex oauth-token branch :169-217 (textarea :170; OAuth btn Codex-cased :164; handleSave :60-85 → onSave `{agentType,credentialKind,credential,autoActivate:true}`). Add guided trigger above the textarea when `agent.id==='openai-codex' && credentialKind==='oauth-token'`.
- Also `apps/web/src/components/ConnectFlow.tsx` Codex textarea :251-258 (Settings›Connections). Factor a shared trigger, drop into both.
- API client `apps/web/src/lib/api/client.ts` `request<T>()` (`credentials:'include'` cookie, `VITE_API_URL`); `apps/web/src/lib/api/agents.ts`. New `apps/web/src/lib/api/codex-setup.ts`.
- Terminal: **`@cloudflare/sandbox/xterm`** (NOT packages/terminal MultiTerminal — incompatible JSON-envelope protocol). Reuse `packages/terminal/src/terminal-tokens.ts` (xtermTheme/fonts/colors) for theming. Add `@cloudflare/sandbox` to apps/web deps for the /xterm subpath. WS token in `?token=` query.
- Modal: `packages/ui/src/components/Dialog.tsx` (`isOpen`, `onClose`, `maxWidth="lg"`, `stickyHeader`).

### wrangler / env / cron
- DO bindings + migration tags + container `max_instances` all propagate via `scripts/deploy/sync-wrangler-config.ts` static copy (top-level only; no `[env.*]`). `[vars]` propagate. DEFAULT_* pattern `apps/api/src/services/timeout.ts:22-35`.
- Next D1 migration = `0097_*.sql` (additive only — rule 31).
- Cron: `scheduled()` `apps/api/src/index.ts:833`; 5-min sweep fall-through :926; add `apps/api/src/scheduled/setup-session-sweep.ts` + `await` after :947 (reuse `*/5`). Bounded (rule 47).
- Gates: `quality:wrangler-bindings`, `quality:migration-safety`, `quality:do-migration-safety`.

## Implementation checklist

### Phase A — Backend foundation (API)
- [ ] `apps/api/src/db/migrations/0097_agent_credential_setup_sessions.sql`: `CREATE TABLE agent_credential_setup_sessions` (id TEXT PK, user_id, agent_type, credential_kind, status, sandbox_id, pool_lease_id, scope, project_id NULL, started_at, expires_at, completed_at, error_message, created_at, updated_at — **NO secret columns**) + `CREATE UNIQUE INDEX ... WHERE status IN ('creating','admitting','provisioning_sandbox','waiting_for_user','capturing','saving')` for one-active per (user_id, agent_type). Add drizzle schema entry in `apps/api/src/db/schema.ts`.
- [ ] jwt.ts: `CREDENTIAL_SETUP_TERMINAL_AUDIENCE`, `signCredentialSetupTerminalToken(userId,setupSessionId,env)`, `verifyCredentialSetupTerminalToken`, payload interface, `getCredentialSetupTerminalTokenExpiry(env)` reading `CREDENTIAL_SETUP_TERMINAL_TOKEN_EXPIRY_MS` (DEFAULT 5min).
- [ ] Shared credential-save service `apps/api/src/services/agent-credential-save.ts`: `saveAgentCredentialForUser({env, db, userId, projectId?, agentType, credentialKind, credential, autoActivate})` = validate → encrypt → legacy write → syncAgentCredentialToCC. Refactor `credentials.ts` PUT + `projects/credentials.ts` PUT to call it (keep behavior identical; covered by rule-28 tests).
- [ ] `SetupSessionPool` DO `apps/api/src/durable-objects/setup-session-pool.ts` (singleton 'global'): `lease(sessionId): {leaseId}|null` and `release(leaseId)` via `transactionSync`; cap = `MAX_CONCURRENT_SETUP_SESSIONS`. Service wrapper `apps/api/src/services/setup-session-pool.ts`.
- [ ] `CredentialSetupSession` DO `apps/api/src/durable-objects/credential-setup-session/` (SQLite + alarm): own `MIGRATIONS`/`runMigrations`, `do_meta`; methods `create(...)`, `getState()`, `cancel()`; internal state machine; provisions sandbox (mkdir setupHome, writeFile config.toml, set CODEX_HOME); capture loop (alarm-driven poll of `${CODEX_HOME}/auth.json` via exec/readFile) → validate → `saveAgentCredentialForUser` → delete auth.json → teardown; expiry alarm; teardown on EVERY terminal state (release pool lease, sandbox.destroy, mark D1). Add its migration file to `DO_MIGRATION_FILES`.
- [ ] Routes `apps/api/src/routes/agent-credential-setup-sessions.ts`: `POST /` (create: gate check, pool lease, insert D1 row, start DO, return {id, status}; 202 if no slot), `GET /:id` (status), `POST /:id/cancel`, `GET /:id/terminal-token` (mint credential-setup token), `GET /:id/terminal/ws` (NO session mw; verify `?token=`, match :id, `return getSandbox(env.SANDBOX, sandboxId).terminal(c.req.raw,{cols,rows})`). Mount in `index.ts`.
- [ ] env.ts: add `CREDENTIAL_SETUP_SESSION` + `SETUP_SESSION_POOL` DO bindings; config vars `MAX_CONCURRENT_SETUP_SESSIONS?`, `SETUP_SESSION_TTL_MS?`, `CREDENTIAL_SETUP_TERMINAL_TOKEN_EXPIRY_MS?`, `CODEX_SETUP_TERMINAL_ENABLED?`. DEFAULT_* readers.
- [ ] wrangler.toml: 2 DO binding blocks + `[[migrations]]` v18/v19 (`new_sqlite_classes`); bump SANDBOX container `max_instances` 3→6. Re-export both DO classes in index.ts.
- [ ] `apps/api/src/scheduled/setup-session-sweep.ts`: bounded select of expired/orphaned active sessions → per-session teardown (DO cancel + pool release), terminal escape path; wire into the 5-min sweep.
- [ ] Gate: `CODEX_SETUP_TERMINAL_ENABLED === 'true'` (default off) AND `SANDBOX_ENABLED === 'true'` required in the create route; add both to `getOptionalProcessEnvVars` in sync-wrangler-config.ts.

### Phase B — Sandbox image
- [ ] `apps/api/Dockerfile.sandbox`: add pinned `@openai/codex@<version>` to the global npm install line (mirror spike). Keep tag == resolved SDK version.

### Phase C — Frontend
- [ ] `apps/web` deps: add `@cloudflare/sandbox` (for `/xterm`).
- [ ] `apps/web/src/lib/api/codex-setup.ts`: create/poll/cancel session + fetch terminal token (via `request()`), build WS URL with `?token=`.
- [ ] `apps/web/src/components/CodexConnectModal.tsx`: wraps `ui` Dialog (`maxWidth="lg"`, stickyHeader); mounts `@cloudflare/sandbox/xterm` against the setup WS; auto-writes `codex login --device-auth\r` on open; shows status (Preparing → Waiting for sign-in → Capturing → Connected/Failed); on success refresh credentials + close.
- [ ] Shared `CodexConnectTrigger` button; wire into `AgentKeyCard.tsx` (above the Codex textarea) and `ConnectFlow.tsx`. Manual paste stays as collapsed fallback.
- [ ] Playwright visual audit (mobile 375 + desktop 1280) of the modal with mock states (idle/preparing/waiting/error) — rule 17. No horizontal overflow.

### Phase D — Tests
- [ ] Unit: jwt sign/verify round-trip + audience/claim rejection; pool lease/release atomicity (cap, release frees a slot); DO state-machine transitions incl. teardown on every terminal state; `saveAgentCredentialForUser` (validate/encrypt/legacy+cc dual-write; isActive gotcha).
- [ ] Vertical slice (rule 35): create session → (mock sandbox exec/readFile with a valid auth.json) → capture → credential saved to BOTH legacy + cc, isActive=1, auth.json deleted, sandbox destroyed, pool released. Include a bad/expired auth.json failure path.
- [ ] Cross-boundary (rule 23): WS terminal route rejects missing/wrong-audience/wrong-setupSessionId token; accepts valid; contract that create-route gate blocks when disabled.
- [ ] Sweep: two-run zombie test (rule 47) — expired session torn down once, not re-selected.
- [ ] Rule 28 regression on the refactored credential-save routes (fallback branches unchanged).

## Acceptance criteria
- A user can click "Connect with Codex" in Settings›Agents (and Connections), see a terminal running `codex login --device-auth` with a device URL+code, and after ChatGPT sign-in the agent card shows Connected (credential saved encrypted, dual-written to cc). *(Final human step = Raphaël's staging test.)*
- Manual `auth.json` paste still works.
- Setup terminal output/credential never persisted to logs/D1/chat; no secret columns in the table.
- One active setup session per (user, agentType); sessions expire (TTL) and clean up (pool released, sandbox destroyed) via alarm + cron sweep.
- Feature is default-off (`CODEX_SETUP_TERMINAL_ENABLED`), requires `SANDBOX_ENABLED`.
- `pnpm lint && typecheck && test && build` green; quality:wrangler-bindings / migration-safety / do-migration-safety pass.

## References
- Idea `01KRPWSZWFT0Y06DH9VEXC7CYQ`; spike `tasks/active/2026-07-06-cloudflare-setup-terminal-staging-spike.md`; branch `sam/weve-previously-talked-setting-01kwwm`.
- Rules: 44 (dual-write writers), 45 (DO mutex), 47 (control-loop budget), 28/41 (credential resolution/snapshot), 34 (callback vs session auth), 23 (cross-boundary contracts), 35 (vertical slice), 31 (migration safety), 17 (UI visual), 30/13 (staging).
