# Security Findings from dispatch_task MCP Tool (PR #409)

## Context

The security auditor was dispatched during PR #409's review phase but completed after merge. These findings were never addressed. See `.claude/rules/14-do-workflow-persistence.md` for the process fix that prevents this from recurring.

## Findings

### HIGH: TOCTOU Race in Rate Limiting

The `dispatch_task` handler uses a D1 COUNT query to check limits, then a separate INSERT to create the task. Concurrent requests can bypass both the per-task dispatch limit (`MCP_DISPATCH_MAX_PER_TASK`) and the per-project active limit (`MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT`) by racing between the COUNT and INSERT.

**Location:** `apps/api/src/routes/mcp.ts` — `handleDispatchTask()`

**Mitigation options:**
- D1 batch (COUNT + INSERT in a single batch call)
- Durable Object mutex to serialize dispatch requests per project
- Optimistic insert with unique constraint + retry

**Accepted trade-off (documented):** Dispatch is infrequent enough that collision is unlikely in practice, but a determined actor could exploit this.

### HIGH: No HTTP-Level Rate Limit on `/mcp` Endpoint

Other mutation endpoints have rate limiting, but the MCP route (`/api/mcp`) does not. An agent (or attacker with a stolen MCP token) can make unlimited requests.

**Location:** `apps/api/src/routes/mcp.ts` — route registration

**Mitigation:** Add KV-based rate limiting consistent with other mutation endpoints.

### MEDIUM: `roles` Array Not Validated Against Allowlist

Session and message MCP tools accept a `roles` array parameter that is not validated against an allowlist of valid role values.

**Location:** `apps/api/src/routes/mcp.ts` — session/message tool handlers

### MEDIUM: Post-Completion Token Read Access

MCP tokens remain valid for read access for up to 2 hours after task completion. This is documented and intentional (allows agents to read final state) but expands the attack window if a token is compromised.

## Implementation Checklist

- [x] Mitigate TOCTOU in dispatch rate limiting (D1 batch) — used D1 `.batch()` for atomic COUNT + INSERT; advisory pre-checks remain for fast-fail
- [x] Add HTTP-level rate limiting to `/mcp` endpoint — 120 req/min per task, configurable via `MCP_RATE_LIMIT` and `MCP_RATE_LIMIT_WINDOW_SECONDS`
- [x] Add allowlist validation for `roles` array in session/message tools — `VALID_MESSAGE_ROLES` allowlist, returns 400 with invalid role names
- [x] Review post-completion token TTL — reduced default from 2 hours to 30 minutes; still configurable via `MCP_TOKEN_TTL_SECONDS`

## Acceptance Criteria

- [x] Concurrent dispatch requests cannot bypass rate limits (test: "should cancel task when atomic check reveals TOCTOU race")
- [x] `/mcp` endpoint returns 429 when rate limit exceeded (test: "should return 429 when rate limit is exceeded")
- [x] Invalid `roles` values are rejected with 400 (tests: "should reject invalid roles in get_session_messages/search_messages")
- [x] Existing MCP tool functionality is not broken (all 2079 tests pass)

## References

- PR #409: `feat: add dispatch_task MCP tool for agent-to-agent task spawning`
- Security auditor subagent report (conversation `d109e1ca-886a-4f6b-b8cd-4a6e4a719f35`)
- Shannon security assessment: `tasks/archive/2026-03-12-shannon-security-assessment.md` (pre-existing KV rate limiter TOCTOU noted as LOW)
