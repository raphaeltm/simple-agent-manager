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
- HIGH: 6
- MEDIUM: 8
- LOW: 4
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

**Assessment: ACCEPTABLE (one scope validation concern)**

The Codex OAuth credential sync (`apps/api/src/routes/workspaces/agent-credential-sync.ts`) re-encrypts with a fresh AES-GCM IV on every update. The `CodexRefreshLock` DO serializes concurrent refresh attempts per-user to prevent rotating-token race conditions.

<a id="finding-medium-7"></a>
#### [MEDIUM-7] Codex scope validation defaults to warn-only (violates Rule 28)

**File:** `apps/api/src/durable-objects/codex-refresh-lock.ts:354-371`
**Severity:** MEDIUM

`CODEX_SCOPE_VALIDATION_MODE` defaults to `'warn'` — unexpected scopes from an upstream OAuth refresh are logged but the rotated token is still accepted and stored. Rule 28 explicitly requires: "rotation validation defaults to a conservative allowlist (not disabled)" and "Rejected rotations MUST NOT persist the new credential."

**Recommendation:** Change default to `'block'`. Make `'warn'` an explicit opt-out via env var.

### 7.1.5 Bootstrap Token Credential Exposure

<a id="finding-high-3"></a>
#### [HIGH-3] Callback JWT stored plaintext in KV bootstrap token data

**File:** `apps/api/src/services/bootstrap.ts:1-80`, `apps/api/src/routes/bootstrap.ts:103-114`
**Severity:** HIGH

The `BootstrapTokenData` stored in KV contains the `callbackToken` (a 24-hour RS256 JWT granting workspace API access) as a plaintext string, while the Hetzner and GitHub tokens in the same blob are correctly AES-GCM encrypted. Anyone who can read KV (Cloudflare support, misconfigured permissions, side-channel) can extract a long-lived callback token.

**Mitigating factors:** Bootstrap tokens are single-use (delete-on-read) with 15-minute TTL, limiting the exposure window. However, the callback token itself has a 24-hour lifetime that extends far beyond the bootstrap window.

**Recommendation:** Either encrypt the `callbackToken` using the same AES-GCM pattern as the other credentials in the bootstrap blob, or reduce callback token TTL to match the bootstrap window and issue a longer-lived token only after the VM proves it received the bootstrap payload (at the `/ready` callback).

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

**Assessment: STRONG (one FTS5 sanitization inconsistency)**

- **Drizzle ORM** (D1): All queries use the builder pattern with parameterized values. No raw SQL string concatenation found.
- **DO SQLite**: Uses `.exec(query, ...params)` with `?` placeholders. Dynamic WHERE clause construction in `apps/api/src/durable-objects/project-data/sessions.ts` builds conditions array and params array separately — safe pattern.
- **FTS5 queries**: Search terms are passed as parameters to `MATCH ?`, not interpolated into the query string. However, the FTS5 query sanitization is inconsistent (see HIGH-2).

<a id="finding-high-2"></a>
#### [HIGH-2] Inconsistent FTS5 query sanitization — `messages.ts` weaker than `knowledge.ts`

**File:** `apps/api/src/durable-objects/project-data/messages.ts:494-498`
**Severity:** HIGH
**Also affects:** `apps/api/src/durable-objects/sam-session/index.ts:101-105`

**Description:**

The `buildFtsQuery` function in `messages.ts` wraps each whitespace-split word in double-quotes and escapes internal quotes (`""`) but does NOT strip FTS5 special characters (`*`, `^`, `NEAR/N`) or filter reserved keywords (`AND`, `OR`, `NOT`, `NEAR`). The stronger implementation in `knowledge.ts:513-522` strips all non-word characters first (`replace(/[^\w\s]/g, ' ')`) and filters reserved keywords.

```typescript
// messages.ts (WEAKER) — preserves FTS5 operators inside quoted tokens
export function buildFtsQuery(query: string): string | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
}

// knowledge.ts (STRONGER) — strips special chars, filters reserved words
function buildFtsQuery(query: string): string | null {
  const cleaned = query.replace(/[^\w\s]/g, ' ').trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/)
    .filter((w) => w && !FTS5_RESERVED.has(w.toUpperCase()));
  return words.join(' ');
}
```

An input like `hello* OR /etc/passwd` could trigger FTS5 prefix queries or operator injection depending on the SQLite build. The same weaker function is duplicated in `sam-session/index.ts`.

**Recommendation:** Replace the `buildFtsQuery` in `messages.ts` and `sam-session/index.ts` with the hardened version from `knowledge.ts`.

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

### 7.3.7 Schema Validation

**Assessment: ACCEPTABLE (with gaps)**

Route handlers use `jsonValidator()` with Valibot schemas for request body validation (89 usages). However, ~30 route handlers bypass this by calling `c.req.json()` directly and casting with `as SomeType`.

<a id="finding-medium-4"></a>
#### [MEDIUM-4] ~30 routes use raw `c.req.json()` without schema validation

**Files:** Representative samples:
- `apps/api/src/routes/knowledge.ts:119,145`
- `apps/api/src/routes/policies.ts:80,123`
- `apps/api/src/routes/admin-sandbox.ts:94,128,170,218`
- `apps/api/src/routes/project-agent.ts:36`
- `apps/api/src/routes/sam.ts:28`
**Severity:** MEDIUM

TypeScript type casts are erased at runtime — there is no runtime enforcement that parsed JSON conforms to the declared type. Risk is highest on admin routes (`admin-sandbox.ts` accepts `{ command: string }` with no structural validation) and agent routes (`project-agent.ts`, `sam.ts` forward messages to DOs without sanitization).

**Recommendation:** Migrate to `jsonValidator(Schema)` — the infrastructure already exists. Priority: admin routes, agent routes, then knowledge/policies.

### 7.3.8 VM Agent WebSocket Origin Check

<a id="finding-medium-5"></a>
#### [MEDIUM-5] VM agent `isOriginAllowed` accepts wildcard `*`

**File:** `packages/vm-agent/internal/server/websocket.go:30-39`
**Severity:** MEDIUM

If `AllowedOrigins` config contains the literal `"*"`, all WebSocket origins are accepted unconditionally. If any deployment path sets this (cloud-init, default config), any website could establish WebSocket connections to the VM agent terminal.

**Recommendation:** Audit all code paths that populate `AllowedOrigins` in `ServerConfig`. Remove the `allowed == "*"` branch or require explicit opt-in with documented security implications.

### 7.3.9 Mermaid SVG Rendering

<a id="finding-medium-6"></a>
#### [MEDIUM-6] Mermaid SVG rendered via DOMPurify — config needs verification

**File:** `apps/web/src/components/MarkdownRenderer.tsx:141`
**Severity:** MEDIUM

The Mermaid renderer uses `containerRef.current.innerHTML = DOMPurify.sanitize(svg, SVG_SANITIZE_CONFIG)`. DOMPurify is the correct approach, but the `SVG_SANITIZE_CONFIG` must explicitly forbid `<foreignObject>`, `<use>`, and external-reference attributes (`href`, `xlink:href`) to prevent bypass. No page-level CSP header provides a backstop.

**Recommendation:** Verify config forbids dangerous SVG elements. Pin DOMPurify version. Consider adding page-level CSP `script-src 'self'`.

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

## 7.4 Token Lifecycle Findings

<a id="finding-high-4"></a>
#### [HIGH-4] Callback JWT tokens have no revocation mechanism

**File:** `apps/api/src/services/jwt.ts` (signCallbackToken, verifyCallbackToken)
**Severity:** HIGH

Workspace callback tokens are stateless RS256 JWTs with 24-hour lifetime. There is no revocation list, KV-based blocklist, or any way to invalidate a token before expiry. When a workspace is deleted/stopped or a user is suspended, outstanding tokens remain valid for up to 24 hours. A malicious agent can continue posting messages, triggering Codex token refreshes, and making AI proxy requests.

**Recommendation:** Add a KV-based revocation check. Set a `jti` claim in `signCallbackToken()`, check `KV.get('revoked-jwt:' + jti)` in `verifyCallbackToken()`. Revoke on workspace deletion/user suspension. Alternatively, reduce default lifetime from 24 hours to 4-8 hours.

<a id="finding-high-5"></a>
#### [HIGH-5] Port-proxy tokens use synthetic `userId: 'port-proxy'` breaking audit trails

**File:** `apps/api/src/index.ts:247`
**Severity:** HIGH

Port-forwarded workspace requests auto-generate a terminal JWT with `userId: 'port-proxy'` — a hardcoded non-user identifier. This breaks audit trails (VM agent logs cannot be correlated to the real user) and the token appears in URL query parameters (`?token=`), making extraction from logs feasible.

**Recommendation:** Pass the real `userId` from the authenticated Worker request context. Consider moving the token from `?token=` to an `Authorization` header in the Worker-to-VM-agent leg.

<a id="finding-high-6"></a>
#### [HIGH-6] MCP rate limiter uses non-atomic KV read-modify-write

**File:** `apps/api/src/routes/mcp/_helpers.ts`
**Severity:** HIGH

The MCP endpoint rate limiter uses KV read-modify-write without compare-and-swap. Under concurrent requests (common for parallel agent tool calls), multiple Workers can read the same counter, increment independently, and write back — allowing burst significantly beyond the 120 req/min limit. Rule 28 requires atomic primitives (DO storage, DB locks) for rate limits guarding sensitive operations.

**Recommendation:** Move MCP rate limiting to a lightweight DO (following the `CodexRefreshLock` pattern already in the codebase) for atomic increment-and-check semantics.

<a id="finding-medium-8"></a>
#### [MEDIUM-8] Smoke test tokens have no expiry

**File:** `apps/api/src/routes/smoke-test-tokens.ts`
**Severity:** MEDIUM

Smoke test tokens remain valid indefinitely until explicitly revoked. A stolen `sam_test_*` token can create new 7-day sessions repeatedly forever. The feature gate (`SMOKE_TEST_AUTH_ENABLED`) must be disabled in production, but no automated enforcement prevents cross-environment token reuse.

**Recommendation:** Add `expiresAt` column to `smokeTestTokens` table. Default maximum lifetime: 30 days. Enforce at `token-login` time.

---

## 7.5 Additional Findings

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

<a id="finding-low-3"></a>
#### [LOW-3] `requireWorkspaceOwnership` lacks SQL-level userId filter

**File:** `apps/api/src/middleware/workspace-auth.ts`
**Severity:** LOW

The `requireWorkspaceOwnership` middleware queries the workspace by ID only, then performs a post-query ownership check. Compare with the stronger pattern in `node-auth.ts` which includes `eq(nodes.userId, userId)` in the WHERE clause. The post-check prevents data disclosure, but the weaker pattern returns the full row for any workspaceId to the application layer.

**Recommendation:** Add `eq(workspaces.userId, userId)` to the WHERE clause, matching `requireWorkspaceOwnershipOnNode` and `node-auth.ts`.

<a id="finding-low-4"></a>
#### [LOW-4] VM agent `files.go` error responses embed raw error messages

**File:** `packages/vm-agent/internal/server/files.go:54,63,67`
**Severity:** LOW

Several error responses use `fmt.Sprintf(`{"error":"%s"}`, err.Error())` which can expose internal paths, container IDs, or Go runtime details. Also produces malformed JSON if `err.Error()` contains double-quotes. Other handlers in the same package use the safer `writeError()` helper.

**Recommendation:** Replace `fmt.Sprintf` JSON error patterns with calls to the existing `writeError()` helper.

---

## Summary of Findings

| ID | Severity | Category | Title | File |
|----|----------|----------|-------|------|
| HIGH-1 | HIGH | Multi-tenant | Workspace subdomain proxy bypasses user ownership | `apps/api/src/index.ts:188-256` |
| HIGH-2 | HIGH | SQL/FTS5 | Inconsistent FTS5 query sanitization in messages.ts | `apps/api/src/durable-objects/project-data/messages.ts:494-498` |
| HIGH-3 | HIGH | Credential exposure | Callback JWT stored plaintext in KV bootstrap data | `apps/api/src/services/bootstrap.ts:1-80` |
| HIGH-4 | HIGH | Token lifecycle | Callback JWT tokens have no revocation mechanism | `apps/api/src/services/jwt.ts` |
| HIGH-5 | HIGH | Audit trail | Port-proxy tokens use synthetic userId | `apps/api/src/index.ts:247` |
| HIGH-6 | HIGH | Rate limiting | MCP rate limiter uses non-atomic KV | `apps/api/src/routes/mcp/_helpers.ts` |
| MEDIUM-1 | MEDIUM | CORS | Wildcard origin for port-forwarded workspace requests | `apps/api/src/index.ts:320-325` |
| MEDIUM-2 | MEDIUM | Rate limiting | Token-login rate limit is IP-only | `apps/api/src/routes/smoke-test-tokens.ts:225-229` |
| MEDIUM-3 | MEDIUM | Cookie security | Terminal token cookie missing SameSite=Strict | `apps/api/src/index.ts:238-256` |
| MEDIUM-4 | MEDIUM | Input validation | ~30 routes use raw `c.req.json()` without schema validation | Multiple routes |
| MEDIUM-5 | MEDIUM | WebSocket | VM agent origin check accepts wildcard `*` | `packages/vm-agent/internal/server/websocket.go:30-39` |
| MEDIUM-6 | MEDIUM | XSS | Mermaid SVG DOMPurify config needs verification | `apps/web/src/components/MarkdownRenderer.tsx:141` |
| MEDIUM-7 | MEDIUM | Credential rotation | Codex scope validation defaults to warn-only | `apps/api/src/durable-objects/codex-refresh-lock.ts:354-371` |
| MEDIUM-8 | MEDIUM | Token lifecycle | Smoke test tokens have no expiry | `apps/api/src/routes/smoke-test-tokens.ts` |
| LOW-1 | LOW | Key management | No built-in key rotation mechanism | `apps/api/src/services/encryption.ts` |
| LOW-2 | LOW | Session mgmt | Session not invalidated on role change | BetterAuth session layer |
| LOW-3 | LOW | Multi-tenant | `requireWorkspaceOwnership` lacks SQL-level userId filter | `apps/api/src/middleware/workspace-auth.ts` |
| LOW-4 | LOW | Info disclosure | VM agent error responses embed raw error messages | `packages/vm-agent/internal/server/files.go:54,63,67` |
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

### P0: Harden FTS5 Query Sanitization (HIGH-2)

**Priority:** P0 — Fix before production launch
**Estimated effort:** 30 minutes
**Blocking:** Production readiness

**Problem:** The `buildFtsQuery` function in `messages.ts` and `sam-session/index.ts` does not strip FTS5 special characters or filter reserved keywords, unlike the hardened version in `knowledge.ts`. This could allow FTS5 operator injection via user search input.

**Implementation:**
1. Replace `buildFtsQuery` in `apps/api/src/durable-objects/project-data/messages.ts:494-498` with the version from `knowledge.ts:513-522` (strip `[^\w\s]`, filter FTS5 reserved words)
2. Replace the duplicate in `apps/api/src/durable-objects/sam-session/index.ts:101-105`
3. Consider extracting to a shared utility to prevent future drift

**Tests required:**
- Unit test: FTS5 operators (`*`, `NEAR`, `OR`, `NOT`) are stripped from search queries
- Unit test: normal search terms still produce valid FTS5 queries
- Regression test: existing search functionality still works

**Files to modify:**
- `apps/api/src/durable-objects/project-data/messages.ts`
- `apps/api/src/durable-objects/sam-session/index.ts`
- Optionally: shared utility extraction

---

### P0: Encrypt Callback JWT in Bootstrap KV Data (HIGH-3)

**Priority:** P0 — Fix before production launch
**Estimated effort:** 1-2 hours
**Blocking:** Production readiness

**Problem:** The `BootstrapTokenData` stored in KV contains the callback JWT (24-hour lifetime, workspace API access) as plaintext, while Hetzner/GitHub tokens in the same blob are AES-GCM encrypted.

**Implementation:**
1. In `apps/api/src/services/bootstrap.ts`, encrypt the `callbackToken` with AES-GCM before storing in KV (same pattern as `encryptedHetznerToken`)
2. In `apps/api/src/routes/bootstrap.ts`, decrypt the callback token during bootstrap redemption
3. Alternatively, reduce callback token TTL to 15 minutes (matching bootstrap TTL) and issue a longer-lived token at the `/ready` callback after VM proves bootstrap receipt

**Tests required:**
- Unit test: bootstrap token creation encrypts callback token
- Unit test: bootstrap token redemption decrypts callback token correctly
- Integration test: full bootstrap flow still works end-to-end

**Files to modify:**
- `apps/api/src/services/bootstrap.ts` (encrypt callback token)
- `apps/api/src/routes/bootstrap.ts` (decrypt on redemption)

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
