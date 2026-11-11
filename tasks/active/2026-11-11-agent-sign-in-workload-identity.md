# Agent sign-in through workload identity (test instances)

SAM task `01M74VYG3BT3DHFAP57TK5620M`, idea `01M74VT8N3SNH7EMSE3J547X37`, branch
`sam/build-agent-sign-through-k5620m`. **Draft PR to `main` only. Never merge, never mark ready.**
The task file lives on the branch (not committed directly to `main`) per the dispatch override.

## Problem

Getting an agent a browser session on a test install (staging, the self-host test box) costs
hours of account juggling. A SAM instance explicitly configured as a test instance should let an
agent running on another, trusted SAM instance sign in as an allowed user there, by presenting
the workload identity (OIDC) token SAM already issues through `exec_with_secrets`.

## Research findings

- **Token**: `signWorkloadIdentityToken()` (`apps/api/src/services/workload-identity-token.ts`)
  signs RS256 with `kid` = JWK thumbprint, `iss = https://api.<BASE_DOMAIN>/oidc`, `typ: JWT`,
  claims from `WorkloadIdentityClaimsSchema` (`packages/shared/src/workload-identity.ts`) plus
  `type: 'workload-identity'`, `sub`, `aud`, `iat`, `exp` (default 300 s, max
  `MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS` = 600), `jti`. JWKS at
  `<issuer>/.well-known/jwks.json` (verified live on production and staging).
- **Existing door**: `POST /api/auth/token-login` (`routes/api-tokens.ts`) — redeems a PAT,
  `assertUserCanCreateSession` then `buildSessionLoginResponse` (`services/session-factory.ts`),
  which calls BetterAuth `internalAdapter.createSession`. **`SMOKE_TEST_AUTH_ENABLED` is no longer
  read by any API code** (only configure-secrets/workflows still pass it); token-login is always
  on. So the "pattern" to follow is: an optional GitHub Environment secret copied to a Worker
  secret by `scripts/deploy/configure-secrets.sh`.
- **Session refresh pitfall**: BetterAuth `getSession` refreshes a session when
  `expiresAt - expiresIn + updateAge <= now` (7 d / 1 d). A session created with a 1 h
  `expiresAt` is therefore extended to 7 days on its first use. A short lifetime needs an
  explicit clamp. `databaseHooks.session.update.after` sees the updated row (id) and runs
  inline outside transactions (`queueAfterTransactionHook`).
- **Role-changing session hooks**: `session.create.after` runs `LOGIN_SELF_HEAL_SQL` (promotes
  the sole real user when no superadmin exists), and `session.create.before` runs
  `bootstrapSessionAllowed` (may promote the bootstrap owner when no superadmin exists). Both are
  inert once an active superadmin exists, so the endpoint requires one (never changes roles).
- **Approval checks**: `assertSessionUserApproved` (suspended always denied; pending denied when
  signup approval is required). Sentinel `SYSTEM_USER_ID` / `status='system'` must be excluded.
- **Atomic primitives**: existing pattern `consumeCallbackTokenRenewalQuota` (single guarded D1
  upsert). KV limiter (`middleware/rate-limit.ts`) is not atomic — fine only as a coarse per-IP
  pre-auth bound.
- **Deploy wiring**: `deploy-reusable.yml` legacy `Configure Worker Secrets` env block,
  shared-engine `SAM_CI_SECRETS_JSON`, `scripts/deploy/installer-engine-ci-env.json` (parity test
  `installer-engine-workflow.test.ts`), `scripts/deploy/types.ts` `OPTIONAL_SECRETS`,
  `scripts/quality/runtime-tunables-baseline.json` `bootstrapExceptions` (new Env scalar must be a
  justified bootstrap exception), `apps/api/wrangler.toml` secret comment list,
  `apps/api/.env.example`, `apps/www/.../reference/configuration.md`.
- **configure-secrets.sh skips unset optional secrets but never deletes them**, so removing the
  GitHub secret would not switch the feature off. This feature queues a deletion when unset.
- **UI**: the sign-in page already reads public `GET /api/config/login-providers`
  (`useLoginProviders`). Smallest surface: add `agentSignIn: boolean` and a one-line notice on
  the sign-in card. Every person signs in through that page.
- **Playwright MCP in this workspace** needed `playwright install-deps chromium` (missing
  `libnspr4`); MCP still reported "Browser is already in use" afterwards — staging verification
  may use a Node Playwright script instead.

## Design

- One Worker secret `AGENT_SIGN_IN_TRUST` = JSON:
  `{ issuer, allowedSources: [{projectId, userId}], allowedTargets: [id|email] | "*",
  sessionTtlSeconds?, maxSignInsPerHour?, jwksCacheSeconds?, clockToleranceSeconds? }`.
  Strict Valibot schema; absent/empty/malformed => endpoint answers the app's normal 404.
- `POST /api/auth/workload-identity-login` body `{ token, target }`.
- Audience = `https://api.<BASE_DOMAIN>/api/auth/workload-identity-login` (this instance's own
  endpoint URL; binds the token to this purpose on this instance).
- Verify with jose `jwtVerify` + per-isolate `createRemoteJWKSet(<issuer>/.well-known/jwks.json)`:
  RS256 only, exact iss/aud, exp/iat with `maxTokenAge` = shared max TTL, required claims,
  `type === 'workload-identity'`.
- Audit table `agent_sign_ins` with `UNIQUE(issuer, jti)`: one guarded `INSERT ... SELECT ...
  WHERE (count in last hour for principal) < limit ON CONFLICT DO NOTHING RETURNING` is the
  replay guard, the per-principal rate limit and the audit record at once.
- Session via `createSessionCookieForUser(env, userId, { ttlSeconds })`; session id recorded on
  the audit row; `session.update.after` hook clamps `expires_at` to the audit row's cap.

## Implementation checklist

- [x] Migration `0234_agent_sign_ins.sql` + drizzle schema
- [x] `services/agent-sign-in/config.ts` (trust config parse, audience, defaults)
- [x] `services/agent-sign-in/verify.ts` (JWKS cache, jwtVerify, claims schema)
- [x] `services/agent-sign-in/ledger.ts` (atomic claim, session link)
- [x] `routes/agent-sign-in.ts` + mount before BetterAuth catch-all
- [x] `session-factory.ts` fixed-expiry option + return session id
- [x] Hard session cap: `sessions.hard_expires_at`, clamped in `session.update.before` (BetterAuth's own refresh write) + read-side check (replaced the first-cut `update.after` clamp, which failed open — Cloudflare/security review)
- [x] Require an active superadmin (role hooks inert); reject `system` sentinel targets
- [x] `Env.AGENT_SIGN_IN_TRUST`; runtime-tunables bootstrap exception
- [x] Deploy wiring: configure-secrets (set, or delete when unset), workflow env blocks,
      installer manifest, OPTIONAL_SECRETS, wrangler.toml comment, .env.example
- [x] `login-providers` exposes `agentSignIn`; sign-in page notice; Playwright audit
- [x] Integration tests (real BetterAuth + SQLite + generated RSA keys + fake JWKS fetch)
- [x] Discrimination proofs for main guards (record in PR)
- [x] Public docs page + configuration reference; staging rule 13 + full reference
- [x] Security auditor + other reviewers
- [ ] Staging: configure trust, exchange real production token, Playwright as smoke user,
      wrong-audience rejection; confirm production has no configuration
- [ ] Draft PR with threat model and "When this lands on the self-host branch"

- [x] Agent sign-in sessions cannot mint longer-lived credentials (PAT, device approval, connector consent, BetterAuth writes except sign-out) — security review HIGH
- [x] Optional `agentProfileId` pin; configurable JWKS timeout; JWKS cache max 1 h

## Review notes

- Security auditor: 0 CRITICAL, 1 HIGH (credential escalation from agent session) fixed; MEDIUM clamp fail-open fixed by in-write clamp;
  MEDIUM printed cookie kept by design (Playwright MCP `browser_run_code` is a vm sandbox without file access) and documented, now
  unescalatable and bounded by the TTL.
- Cloudflare: clamp per-request double write and fail-open fixed; duplicate approval read removed; lint fixed. Agent sessions still do
  BetterAuth's own refresh UPDATE on every request (a <6-day session is always "due"); accepted for low-traffic test sessions.
- `agent_sign_ins` retention: kept as the durable audit record; growth bounded by `maxSignInsPerHour` per allowed principal.

## Acceptance criteria

- Feature off (absent/empty/malformed) => 404 identical to unknown route.
- Each rejection case in the brief has a test against the real route; success control shows
  `/api/auth/me` works with the cookie and an audit row exists.
- Session lifetime stays bounded after a BetterAuth refresh.
- An agent signs in on staging through this path; wrong audience is rejected live.

## CodeRabbit round (task `01M75A21P5H2T3VXANW3GK8JX2`, 2026-11-11)

CodeRabbit reviewed at 12:40Z with five findings. Owner approved shipping; PR stays unmerged
until the coordinator merges.

- [x] F1: session-minted tokens capped at the hard expiry (`credentialNotAfter`, `cappedExpiry`):
      port access, terminal, node management, local forward. Terminal tokens carry
      `sessionNotAfter`; the VM agent caps the 24 h session cookie it makes from them
      (`packages/vm-agent/internal/auth/session.go sessionExpiry`), because
      `{node}.vm.{domain}:8443` bypasses the Worker. Terminal-token liveness checks the hard cap.
- [x] F2: BetterAuth guard resolves the session through BetterAuth; no cookie substring check.
      Regression test with `session_token =VALUE` (verified red with the old shortcut).
- [x] F3: triggers of every source type refused; PATCH only to pause/disable.
- [x] Same class, found by enumeration: schedules (create/reschedule/reconcile), standing
      watches (create/update), push subscriptions, public ports.
- [x] F4: Landing disclosure: remembered `false` never hides it; failed lookup says unknown.
- [x] F5: guide: turning off does not end sessions; revocation procedure, tested statement.
- [x] Discrimination proofs A-I (see PR body).
- [ ] Security auditor on the new diff
- [ ] Staging redeploy + live check (agent sign-in, F1-F3 refused live)
- [ ] CodeRabbit threads replied/resolved; incremental review wait

Residuals filed/flagged for Raphaël:
- Agent runs (chat/task) started by an agent session hold their own MCP token for the run's
  lifetime; MCP tools (e.g. webhook trigger create) are not session-aware.
- Persistent configuration (credentials, base URLs, runtime env, profiles, skills) set by the
  session is read by later runs; not enforceable route by route.
- `tasks/backlog/2026-11-11-mcp-connection-url-change-keeps-stored-secret.md` (pre-existing).
- Old VM agents ignore `sessionNotAfter` until nodes rotate.
