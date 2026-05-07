# Track 7: Security & Multi-Tenant Isolation

**Status:** Complete
**Evaluator:** Claude Opus 4.6
**Date:** 2026-05-07
**Scope:** Credential encryption, key management, credential resolution, token lifecycle, multi-tenant isolation, input validation, injection risks

---

## Executive Summary

SAM's security posture is **strong for a pre-production platform**. The BYOC credential model, AES-256-GCM encryption with unique IVs, parameterized queries throughout, and defence-in-depth ownership checks represent solid engineering. However, one HIGH-severity finding (workspace subdomain proxy bypasses user ownership) warrants immediate attention before production launch.

**Finding Distribution:**
- CRITICAL: 0
- HIGH: 1
- MEDIUM: 3
- LOW: 2
- INFO: 3

---

## 7.1 Credential Security

### 7.1.1 Encryption Implementation

**Assessment: STRONG**

The encryption service (`apps/api/src/services/encryption.ts`) implements AES-256-GCM correctly:

- **Unique IV per encryption** (line 45): `crypto.getRandomValues(new Uint8Array(12))` — 96-bit random IV for every encrypt operation
- **Web Crypto API** — uses the platform's native cryptographic primitives, not a userland library
- **Key derivation** — uses `importKey('raw', ...)` with the base64-decoded encryption key
- **Error handling** (lines 89-92) — decryption failures are logged without leaking ciphertext or IV values
- **No IV reuse** — each encryption call generates a fresh IV; IV is stored alongside ciphertext in the DB

**Credential storage pattern** (`apps/api/src/db/schema.ts`):
```
credentials table: id, user_id, provider, encrypted_token, iv, project_id, is_active
```

Each credential row stores its own IV, ensuring no two encryptions share an IV even with the same key.

### 7.1.2 Key Management

**Assessment: ACCEPTABLE (with noted risks)**

Key hierarchy (`apps/api/src/lib/secrets.ts`):

| Function | Returns | Fallback |
|----------|---------|----------|
| `getCredentialEncryptionKey()` | `CREDENTIAL_ENCRYPTION_KEY` | `ENCRYPTION_KEY` |
| `getBetterAuthSecret()` | `BETTER_AUTH_SECRET` | `ENCRYPTION_KEY` |
| `getGithubWebhookSecret()` | `GITHUB_WEBHOOK_SECRET` | `ENCRYPTION_KEY` |

<a id="finding-info-1"></a>
#### [INFO-1] Single ENCRYPTION_KEY fallback increases blast radius

**File:** `apps/api/src/lib/secrets.ts:3-15`
**Severity:** INFO
**Status:** Documented accepted risk (see `docs/architecture/secrets-taxonomy.md`)

When purpose-specific keys are not set, all three domains (session signing, credential encryption, webhook verification) share the same key material. Compromise of one domain compromises all three. The documentation recommends setting purpose-specific keys for production — this is an operational concern, not a code defect.

### 7.1.3 Credential Resolution (3-Tier)

**Assessment: STRONG**

The credential resolution order (project-scoped > user-scoped > platform) is implemented in `apps/api/src/services/credentials.ts` via `getDecryptedAgentKey()`. Key security properties:

- **Inactive project-scoped row blocks fallback** — an `is_active=0` project row does NOT fall through to user-tier. This is the critical invariant per `.claude/rules/28-credential-resolution-fallback-tests.md`.
- **userId always in WHERE clause** — cross-user credential access is impossible at the query layer
- **Post-query assertOwnership** — defence-in-depth check after query returns

### 7.1.4 OAuth Token Sync-Back

**Assessment: ACCEPTABLE**

The Codex OAuth credential sync (`apps/api/src/routes/workspaces/agent-credential-sync.ts`) re-encrypts with a fresh AES-GCM IV on every update. The `CodexRefreshLock` DO serializes concurrent refresh attempts per-user to prevent rotating-token race conditions.

---

## 7.2 Multi-Tenant Isolation

### 7.2.1 D1 Query Layer

**Assessment: STRONG**

All D1 queries use Drizzle ORM with parameterized values. Every user-facing query includes `eq(table.userId, userId)` in the WHERE clause. Spot-checked:

- `apps/api/src/routes/projects.ts` — all project queries filter by userId
- `apps/api/src/routes/tasks.ts` — task queries join through project ownership
- `apps/api/src/routes/credentials.ts` — credential queries filter by userId AND projectId when applicable
- `apps/api/src/routes/nodes.ts` — node queries filter by userId

### 7.2.2 Durable Object Access

**Assessment: STRONG**

ProjectData DOs are keyed by `projectId` (`env.PROJECT_DATA.idFromName(projectId)`). Access is gated by `requireOwnedProject()` middleware which:
1. Queries the project with userId filter (line 37-42 in `apps/api/src/middleware/project-auth.ts`)
2. Performs post-query `assertOwnership()` check (line 19-28)

The DO itself does not perform ownership checks — it trusts the API layer has already validated. This is acceptable given the single entry point through the Worker.

### 7.2.3 VM/Node Selection

**Assessment: STRONG**

Node selection for task execution filters by userId at the query layer. The TaskRunner DO (`apps/api/src/durable-objects/task-runner.ts`) resolves nodes through the user's credential, ensuring a user can only provision VMs with their own cloud provider token.

### 7.2.4 Workspace Access Control

<a id="finding-high-1"></a>
#### [HIGH-1] Workspace subdomain proxy bypasses user ownership verification

**File:** `apps/api/src/index.ts:188-256`
**Severity:** HIGH
**Impact:** Any authenticated user who knows/guesses a workspace ID can proxy requests to another user's workspace

**Description:**

The workspace subdomain proxy handler (lines 164-280 in `apps/api/src/index.ts`) processes requests to `ws-{id}.{BASE_DOMAIN}` and `ws-{id}--{port}.{BASE_DOMAIN}`. The flow:

1. Extracts `workspaceId` from the subdomain (line 178)
2. Queries the workspace by ID only — **no userId filter** (lines 188-195)
3. For port-forwarded requests, generates a terminal JWT and injects it as a cookie (lines 238-256)

**Missing:** There is no check that the requesting user owns the workspace. The query at line 188 is:
```typescript
const workspace = await db.query.workspaces.findFirst({
  where: eq(workspaces.id, workspaceId)  // No userId filter!
});
```

**Mitigating factors:**
- The workspace ID is a ULID — not enumerable, requires knowledge of the target
- The VM agent validates the JWT token for most operations
- Workspace subdomains are not publicly linked or indexed

**Why still HIGH:** In a multi-tenant platform, knowledge of a workspace ID (which appears in URLs, logs, and API responses) should not be sufficient for access. The VM agent JWT is generated BY this proxy for the requester — so the proxy authenticates on behalf of any user who reaches it.

**Recommendation:** Add `eq(workspaces.userId, userId)` to the workspace query, or call `requireWorkspaceOwnership()` before proxying.

### 7.2.5 Admin Endpoint Protection

**Assessment: STRONG**

All admin routes (`/api/admin/*`) are protected with `requireSuperadmin()` middleware which checks `user.role === 'superadmin'`. Verified across:
- `apps/api/src/routes/admin-costs.ts`
- `apps/api/src/routes/admin-ai-usage.ts`
- `apps/api/src/routes/admin-users.ts`
- `apps/api/src/routes/admin-overview.ts`

---

## 7.3 Input Validation & Injection

### 7.3.1 SQL Injection

**Assessment: STRONG (no findings)**

- **Drizzle ORM** (D1): All queries use the builder pattern with parameterized values. No raw SQL string concatenation found.
- **DO SQLite**: Uses `.exec(query, ...params)` with `?` placeholders. Dynamic WHERE clause construction in `apps/api/src/durable-objects/project-data/sessions.ts` builds conditions array and params array separately — safe pattern.
- **FTS5 queries**: Search terms are passed as parameters to `MATCH ?`, not interpolated into the query string.

### 7.3.2 Path Traversal

**Assessment: STRONG**

The VM agent's `sanitizeFilePath()` function (`packages/vm-agent/internal/server/git.go:297-317`):
- Rejects null bytes
- Applies `filepath.Clean()` to normalize path
- Rejects any path containing `..` components after cleaning
- Rejects absolute paths (starting with `/`)

Called by all file-related handlers (`handleFileList`, `handleFileFind`, `handleFileRaw`).

The API Worker's `normalizeProjectFilePath()` provides similar validation at the proxy layer before forwarding to the VM agent.

### 7.3.3 Command Injection

**Assessment: STRONG**

The VM agent exclusively uses `exec.CommandContext()` with explicit argument arrays — never `sh -c` with string interpolation. Verified across:
- `packages/vm-agent/internal/server/files.go:81-84` — `find` with direct args
- `packages/vm-agent/internal/server/files.go:154-165` — `find` with direct args
- `packages/vm-agent/internal/server/files.go:332` — `docker exec cat -- filePath`
- `packages/vm-agent/internal/server/git.go` — all git commands use args arrays

Comments in the code explicitly note "Args are passed directly (no shell) to prevent shell injection" (files.go:74).

### 7.3.4 XSS

**Assessment: STRONG**

- No usage of `dangerouslySetInnerHTML` found in the React codebase
- React's default escaping handles user-provided content
- SVG files served via `handleFileRaw` include `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` (files.go:319)
- `X-Content-Type-Options: nosniff` header set on raw file responses (files.go:315)

### 7.3.5 CORS Configuration

**Assessment: STRONG**

CORS origin validation (`apps/api/src/index.ts:302-331`):
- Parses origin as URL to extract hostname
- Uses proper subdomain check: `hostname === baseDomain || hostname.endsWith('.' + baseDomain)`
- Returns `null` (deny) for unrecognized origins — correct default-deny pattern
- Workspace port-forwarding requests use `origin: '*'` with `credentials: false` — appropriate for token-auth endpoints

<a id="finding-medium-1"></a>
#### [MEDIUM-1] CORS wildcard for port-forwarded workspace requests

**File:** `apps/api/src/index.ts:320-325`
**Severity:** MEDIUM

Port-forwarded workspace requests (`ws-{id}--{port}.{domain}`) use `origin: '*'` which is technically correct (these use token auth not cookies) but means any website can make requests to exposed workspace ports. This is by design (workspace ports are user-controlled services) but worth noting for the threat model.

### 7.3.6 Request Validation

<a id="finding-medium-2"></a>
#### [MEDIUM-2] Smoke test token-login endpoint rate limit is IP-only

**File:** `apps/api/src/routes/smoke-test-tokens.ts:225-229`
**Severity:** MEDIUM

The `POST /api/auth/token-login` rate limit uses `useIp: true` only (20 attempts/hour/IP). Behind Cloudflare, all requests from the same IP share the rate limit window. A distributed attacker with multiple IPs could attempt brute-force against the token space. However, the token space is 256 bits (32 bytes base64url) making brute force computationally infeasible regardless of rate limiting.

**Mitigating factors:** Token entropy (256 bits) makes brute-force impossible. The rate limit exists primarily to prevent credential stuffing with leaked tokens.

### 7.3.7 Zod/Schema Validation

**Assessment: ACCEPTABLE**

Route handlers use `jsonValidator()` with Zod schemas for request body validation (e.g., `SmokeTestCreateSchema`, `SmokeTestRedeemSchema`). This provides type-safe input validation at the API boundary.

---

## Token & Auth Mechanism Map

| Token Type | Algorithm | Lifetime | Scope | Storage | Refresh Mechanism |
|------------|-----------|----------|-------|---------|-------------------|
| BetterAuth session | HMAC-SHA256 signed cookie | 7 days (default) | User session | D1 `sessions` table | Session refresh on activity |
| Workspace callback JWT | RS256 | 24 hours | Single workspace | Stateless (verified by public key) | Auto-refresh at 50% lifetime during heartbeats |
| Node callback JWT | RS256 | 24 hours | Single node | Stateless | Auto-refresh at 50% lifetime during heartbeats |
| Terminal token JWT | RS256 | 1 hour | Single workspace | Stateless | New token per WebSocket session |
| MCP token JWT | RS256 | 4 hours | Single task | Stateless | Reused for task duration |
| Smoke test token | SHA-256 hashed | No expiry (revocable) | User authentication | D1 `smoke_test_tokens` (hash only) | N/A — revoke and regenerate |
| Codex OAuth tokens | Provider-issued | Provider-defined | AI inference | D1 `credentials` (encrypted) | Serialized refresh via CodexRefreshLock DO |
| GCP identity token | RS256 JWT | 10 minutes | Deployment operations | Stateless | One-shot per operation |

### Auth Flow Boundaries

```
Browser → API Worker:     BetterAuth session cookie (HMAC-SHA256 signed)
API Worker → VM Agent:    Workspace callback JWT (RS256) in Authorization header
VM Agent → API Worker:    Workspace callback JWT in Authorization header or ?token= query param
Browser → VM Agent:       Terminal JWT (RS256) via cookie (set by workspace proxy)
Agent → API Worker (MCP): MCP token JWT (RS256) in Authorization header
```

<a id="finding-info-2"></a>
#### [INFO-2] Token-in-URL for Codex refresh proxy

**File:** `apps/api/src/routes/workspaces/codex-refresh.ts`
**Severity:** INFO
**Status:** Documented accepted risk (see `docs/architecture/secrets-taxonomy.md`)

The Codex refresh endpoint receives its callback token via `?token=` URL query parameter because Codex CLI's refresh mechanism does not support custom HTTP headers. Mitigated by short token lifetime, scope enforcement, RS256 verification, rate limiting, and kill switch. See full mitigation analysis in the secrets taxonomy document.

<a id="finding-medium-3"></a>
#### [MEDIUM-3] Terminal token set as cookie by workspace proxy without SameSite=Strict

**File:** `apps/api/src/index.ts:238-256`
**Severity:** MEDIUM

The workspace proxy generates a terminal JWT and sets it as a cookie for port-forwarded requests. The cookie attributes should include `SameSite=Strict` to prevent CSRF against the VM agent's WebSocket endpoint. Currently relies on the VM agent's own token validation, but a Strict cookie would add defence-in-depth.

---

## 7.4 Additional Findings

<a id="finding-low-1"></a>
#### [LOW-1] Encryption key rotation has no built-in mechanism

**Severity:** LOW

There is no automated key rotation for `CREDENTIAL_ENCRYPTION_KEY`. Re-encrypting all credentials requires a manual migration script. For a pre-production platform this is acceptable, but a production deployment should have a key rotation plan.

<a id="finding-low-2"></a>
#### [LOW-2] Session token not invalidated on password/role change

**Severity:** LOW

BetterAuth sessions persist independently of user role changes. If an admin demotes a user to a non-approved status, their existing session remains valid until expiry. The `requireApproved()` middleware checks user status on each request, which mitigates this — but the session itself is not revoked.

<a id="finding-info-3"></a>
#### [INFO-3] DO SQLite has no row-level encryption

**Severity:** INFO

ProjectData DO SQLite stores chat messages, knowledge entities, and session metadata in plaintext. This data is not user credentials (those are in D1 with AES-GCM), but for highly sensitive conversations, at-rest encryption would provide additional protection. Cloudflare encrypts DO storage at the infrastructure level, making this a defence-in-depth consideration rather than a vulnerability.

---

## Summary of Findings

| ID | Severity | Category | Title | File |
|----|----------|----------|-------|------|
| HIGH-1 | HIGH | Multi-tenant | Workspace subdomain proxy bypasses user ownership | `apps/api/src/index.ts:188-256` |
| MEDIUM-1 | MEDIUM | CORS | Wildcard origin for port-forwarded workspace requests | `apps/api/src/index.ts:320-325` |
| MEDIUM-2 | MEDIUM | Rate limiting | Token-login rate limit is IP-only | `apps/api/src/routes/smoke-test-tokens.ts:225-229` |
| MEDIUM-3 | MEDIUM | Cookie security | Terminal token cookie missing SameSite=Strict | `apps/api/src/index.ts:238-256` |
| LOW-1 | LOW | Key management | No built-in key rotation mechanism | `apps/api/src/services/encryption.ts` |
| LOW-2 | LOW | Session mgmt | Session not invalidated on role change | BetterAuth session layer |
| INFO-1 | INFO | Key management | Single ENCRYPTION_KEY fallback | `apps/api/src/lib/secrets.ts:3-15` |
| INFO-2 | INFO | Token exposure | Token-in-URL for Codex refresh | Documented accepted risk |
| INFO-3 | INFO | Data at rest | DO SQLite has no row-level encryption | ProjectData DO |

---

## Follow-Up Task Packets

### P0: Workspace Proxy Ownership Check (HIGH-1)

**Priority:** P0 — Fix before production launch
**Estimated effort:** 1-2 hours
**Blocking:** Production readiness

**Problem:** The workspace subdomain proxy (`apps/api/src/index.ts:188-256`) queries workspaces by ID only, without verifying the requesting user owns the workspace. Any authenticated user who knows a workspace ID can proxy requests to it.

**Implementation:**
1. In the workspace subdomain handler (line 188), add userId to the workspace query:
   ```typescript
   const workspace = await db.query.workspaces.findFirst({
     where: and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId))
   });
   ```
2. Alternatively, call the existing `requireWorkspaceOwnership()` middleware before proxying
3. Return 404 (not 403) for workspaces owned by other users to prevent enumeration
4. For unauthenticated requests to workspace subdomains (port-forwarded services), determine if public access is intentional — if so, document the threat model explicitly

**Tests required:**
- Integration test: authenticated user A cannot proxy to user B's workspace
- Integration test: unauthenticated requests are rejected (or explicitly allowed with documentation)
- Regression test: workspace owner can still proxy normally

**Files to modify:**
- `apps/api/src/index.ts` (workspace subdomain handler)
- `apps/api/tests/integration/` (new test file)

---

### P1: Terminal Token Cookie Hardening (MEDIUM-3)

**Priority:** P1 — Address before production launch
**Estimated effort:** 30 minutes

**Problem:** The terminal JWT cookie set by the workspace proxy should include `SameSite=Strict` for CSRF defence-in-depth.

**Implementation:**
1. In `apps/api/src/index.ts:238-256`, add `SameSite=Strict` to the cookie attributes
2. Verify this doesn't break the WebSocket upgrade flow (WebSocket connections from the same origin should still send the cookie)

**Tests required:**
- Verify WebSocket connections still authenticate correctly after the change
- Manual staging verification with a real workspace terminal session

**Files to modify:**
- `apps/api/src/index.ts` (cookie setting in workspace proxy)

---

### P1: Document Port-Forward CORS Threat Model (MEDIUM-1)

**Priority:** P1 — Document before production
**Estimated effort:** 30 minutes

**Problem:** Port-forwarded workspace requests use `origin: '*'` which allows any website to make requests to exposed workspace ports. This may be intentional (workspace ports host user-controlled services) but the threat model should be explicitly documented.

**Implementation:**
1. Add a section to `docs/architecture/secrets-taxonomy.md` under "Accepted Risks" documenting the port-forward CORS model
2. Document that exposed workspace ports are user-controlled and any website can access them
3. Consider whether a user-configurable allowlist would be valuable for production

**Files to modify:**
- `docs/architecture/secrets-taxonomy.md` (new accepted risk section)

---

## Strengths Worth Preserving

1. **Defence-in-depth ownership checks** — `assertOwnership()` post-query pattern catches ORM bugs
2. **Unique IV per encryption** — prevents IV-reuse attacks even under high write volume
3. **No shell execution** — VM agent consistently uses `exec.CommandContext` with args arrays
4. **Parameterized queries everywhere** — Drizzle ORM + DO `.exec()` with `?` placeholders
5. **Purpose-specific key overrides** — optional key isolation reduces blast radius
6. **Credential resolution inactive-blocks-fallback invariant** — prevents unintended credential promotion
7. **Origin parsing for CORS** — uses `new URL()` hostname comparison, not substring matching
8. **SVG CSP headers** — prevents XSS via uploaded SVG files
