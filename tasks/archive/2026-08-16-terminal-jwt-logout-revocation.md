# Terminal JWT Logout Revocation

## Problem

Workspace terminal JWTs minted by `POST /api/terminal/token` remain usable for new workspace WebSocket connections after the minting browser session logs out. PR #1813 removed client-side persistence and teardown gaps, but the server-side workspace proxy still accepts any unexpired `workspace-terminal` JWT whose subject owns the workspace.

Live staging reproduction on 2026-08-16:

- Workspace `01M05DPW6YDCBTJ9EHVXDFXGTZ` reached `running`.
- Before logout, `POST /api/terminal/token` returned 200 and `wss://ws-01m05dpw6ydcbtj9ehvxdfxgtz.sammy.party/terminal/ws/multi?token=<captured>` returned `session_created`.
- Logout with browser-origin headers returned 200.
- After logout, `/api/auth/me` returned 401 and a fresh `POST /api/terminal/token` returned 401.
- The captured pre-logout token still opened a new terminal WebSocket and returned `session_created`.

## Research Findings

- `apps/api/src/routes/terminal.ts` mints terminal tokens after `requireAuth()` and `requireApproved()`, checks workspace ownership/status, then calls `signTerminalToken(userId, workspaceId, env)`.
- `apps/api/src/services/jwt.ts` signs `workspace-terminal` JWTs with `sub=userId`, `workspace=workspaceId`, and env-configurable `TERMINAL_TOKEN_EXPIRY_MS`. The fallback expiry is currently inline and should be moved behind a `DEFAULT_*` constant while this code is touched.
- `apps/api/src/index.ts` handles `ws-*` workspace subdomain proxying. It accepts a valid terminal token when no app session cookie is present, checks only workspace claim, subject, and D1 workspace ownership, then forwards the request to the VM agent.
- The BetterAuth `sessions` table exists in `apps/api/src/db/schema.ts` with `id`, `token`, `expiresAt`, and `userId`. Logout removes or invalidates the current browser session row; checking this row on terminal-token use binds token liveness to logout without adding KV revocation state. Live staging showed token-login sessions expose `session.token` reliably, so browser terminal JWTs bind to the BetterAuth session token and the liveness gate queries `sessions.token`.
- `users.status` is already an unconditional access-denial boundary for normal authenticated routes through `assertUserNotSuspended()`. Terminal-token-only workspace proxy traffic bypasses that browser-session middleware and must enforce the same suspension check when validating captured tokens.
- Existing internal `port-proxy` tokens are minted with `sub='port-proxy'` by the Worker for VM-agent port proxy calls and are already rejected as browser workspace-proxy credentials. They must remain compatible with old VM agents and should not require a browser session claim for Worker-to-VM internal use.
- Relevant retained lessons:
  - `tasks/archive/2026-05-08-conversation-agent-offline.md`: token-only workspace proxy auth is required because workspace subdomain traffic does not carry `api.*` cookies.
  - `tasks/archive/2026-05-08-port-access-tokens.md`: exposed port access relies on a distinct port-token/cookie flow and must not regress.
  - `tasks/archive/2026-08-16-account-suspension-unconditional-denial.md`: suspension must be enforced before role/config bypasses and must not rely on cached browser-session state.

## Implementation Checklist

- [x] Add a session-binding claim to browser-minted terminal JWTs using the current BetterAuth session token from `getAuth(c)`.
- [x] Keep `signTerminalToken()` backward-compatible for internal Worker-to-VM uses by making session binding optional at signing time, while requiring it only for browser workspace-proxy token authentication.
- [x] Add a workspace-proxy liveness helper that, after JWT verification, fails closed unless:
  - [x] the token includes a non-empty session token;
  - [x] a BetterAuth session row exists for that session token and token subject;
  - [x] the session is not expired;
  - [x] the user row exists and is not suspended.
- [x] Apply the liveness helper in `apps/api/src/index.ts` before D1 workspace routing/proxying for token-only workspace subdomain requests.
- [x] Preserve app-session-cookie workspace proxy behavior for active sessions.
- [x] Preserve port-access token/cookie behavior and internal `port-proxy` token generation.
- [x] Move terminal token default expiry fallback to a `DEFAULT_*` constant.
- [x] Add behavioral tests for:
  - [x] mint token → logout/session row removed → new workspace-proxy WebSocket upgrade rejected;
  - [x] active minting session still allows a new workspace-proxy connection;
  - [x] suspended token subject rejected even with an otherwise live session;
  - [x] missing session claim and missing/ambiguous DB state fail closed;
  - [x] terminal route passes the current auth session token into browser-minted tokens.
- [x] Preserve internal control-plane attachment uploads by routing Worker-to-VM calls through `{nodeId}.vm.*` instead of the browser `ws-*` proxy gate.
- [x] Run focused API tests and broader local validation.
- [x] Complete specialist review, staging deploy, and live staging verification.
- [x] Clean up staging workspace/node `01M05DPW6YDCBTJ9EHVXDFXGTZ` or any replacement verification workspace.

## Local Validation

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/vm-agent-cross-boundary-contract.test.ts tests/unit/services/terminal-token-liveness.test.ts tests/unit/workspace-proxy-ownership.test.ts tests/unit/workspace-proxy-port-access.test.ts tests/unit/routes/terminal.test.ts tests/unit/node-agent-contract.test.ts` — passed, 6 files / 129 tests.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `git diff --check` — passed.
- Earlier full local run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed lint/typecheck and changed API tests; the final aggregate test command hit unrelated web `project-triggers` timeouts under repository-wide concurrency. Isolated reruns of the timed-out web test and adjacent API route tests passed.
- `pnpm build` — passed.
- `pnpm check:fast` — passed.
- After live staging exposed that BetterAuth token-login provides `session.token` rather than `session.id`, reran:
  - `pnpm --filter @simple-agent-manager/api test -- tests/unit/vm-agent-cross-boundary-contract.test.ts tests/unit/services/terminal-token-liveness.test.ts tests/unit/workspace-proxy-ownership.test.ts tests/unit/workspace-proxy-port-access.test.ts tests/unit/routes/terminal.test.ts tests/unit/node-agent-contract.test.ts` — passed, 6 files / 129 tests.
  - `pnpm --filter @simple-agent-manager/api typecheck` — passed.
  - `pnpm --filter @simple-agent-manager/api lint` — passed.
  - `git diff --check` — passed.
  - `pnpm check:fast` — passed.
  - `pnpm --filter @simple-agent-manager/api build` — passed.

## Specialist Review

- `security-auditor` — passed. Browser terminal token minting now embeds the current auth session token, token-only workspace-proxy upgrades verify that session/user row before proxying, missing session state fails closed, and suspended users are denied by the same signup/suspension gate. Session token values are not logged.
- `cloudflare-specialist` — passed. The gate is enforced in the Worker workspace proxy before forwarding to the VM agent; no KV read-modify-write revocation state was added; D1 session/user lookup is read-only and fail-closed. Internal Worker-to-VM attachment uploads use `{nodeId}.vm.*` routing so they do not depend on browser proxy semantics.
- `constitution-validator` — passed. Terminal token TTL fallback uses `DEFAULT_TERMINAL_TOKEN_EXPIRY_MS` and remains overridable by `TERMINAL_TOKEN_EXPIRY_MS`; no new hardcoded TTL/rate-limit/revocation constants were introduced.
- `test-engineer` — passed. Behavioral tests cover active session allowed, logout/session-row removal denied, suspended user denied, missing session claim denied, mismatched session/user denied, proxy not forwarding on denied token, mint route passing session token, and internal VM-agent routing contract.

## Staging Verification

- Staging deploy `31954011519` for SHA `8cfe208ba74ce52db00f48f083a0fda27c4f9372` succeeded, but targeted live verification failed: a freshly minted terminal token still lacked a session-binding claim and the captured token still opened a new `wss://ws-.../terminal/ws/multi` connection after logout. This discriminatory failure exposed that the implementation used `auth.session.id`, while the live token-login session path exposes `auth.session.token`.
- Corrected staging deploy `31955598604` for SHA `24854e6fc7227e5e726060fb432813f1a7321371` succeeded, including smoke tests.
- Final live verification on workspace `01M05MWGT3QTFYQ9JWK4P9ZES4` / node `01M05MWGAG3QCETJEFETFX6BTD`:
  - Browser token-login session minted terminal token: `POST /api/terminal/token` returned 200; decoded JWT had `aud=workspace-terminal`, matching workspace claim, and `sessionTokenPresent=true`.
  - Captured token before logout opened `wss://ws-01m05mwgt3qtfyq9jwk4p9zes4.sammy.party/terminal/ws/multi` and returned `session_created`.
  - Logout returned 200; `/api/auth/me` returned 401; fresh `POST /api/terminal/token` returned 401.
  - Reusing the captured pre-logout token for a new WebSocket returned browser `error` before open and did not return `session_created`.
  - A second browser token-login session minted a fresh token with `sessionTokenPresent=true`; new WebSocket returned `session_created`.
  - Cleanup `DELETE /api/workspaces/01M05MWGT3QTFYQ9JWK4P9ZES4` returned 200 and `/api/workspaces` default list returned `[]`.

## Task Completion Validation

- `task-completion-validator` — passed. The implementation checklist has no open items; the diff contains the terminal-token session-token claim, Worker proxy liveness gate, fail-closed D1 session/user lookup, suspension denial, internal Worker-to-VM attachment routing compatibility, env-backed default TTL, behavioral tests, staging deploy evidence, final live verification evidence, and cleanup evidence.

## Acceptance Criteria

- Previously minted browser terminal tokens are rejected for new workspace WebSocket/proxy connections after the minting auth session logs out.
- A terminal token from a still-live, non-suspended session continues to authorize new workspace WebSocket/proxy connections.
- Suspended users cannot use previously minted terminal tokens.
- Missing session claims, missing session rows, expired sessions, missing user rows, or mismatched session/user state reject without proxying.
- Existing live WebSocket connections are not explicitly terminated server-side by this change; they rely on the existing client logout cleanup from PR #1813 and VM/workspace lifecycle. The new server gate applies to new Worker-mediated upgrades.
- No VM-agent protocol change is required; old VM agents remain compatible because the Worker enforces the new liveness gate before forwarding and internal Worker-to-VM tokens remain valid.
- PR body documents the session-binding design tradeoff and includes local tests, specialist review evidence, staging deployment, live staging verification, CI link, head SHA, and cleanup evidence.
- PR remains open and unmerged.

## References

- SAM idea `01M04ZCW9C1NAAN88F0VVYCSVN`
- PR #1813: https://github.com/raphaeltm/simple-agent-manager/pull/1813
- PR #1834: https://github.com/raphaeltm/simple-agent-manager/pull/1834
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/06-technical-patterns.md`
- `.claude/rules/11-fail-fast-patterns.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/51-server-side-node-class-gates.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
