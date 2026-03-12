# Fix Shannon Security Assessment HIGH/CRITICAL Vulnerabilities

## Problem

Shannon AI pentester identified multiple HIGH and CRITICAL vulnerabilities in a live assessment of `app.sammy.party`. This task addresses all confirmed exploitable findings.

## Findings to Fix

### CRITICAL
1. **INJ-VULN-03**: Arbitrary file write via runtime files API — absolute paths like `/etc/cron.d/`, `~/.ssh/authorized_keys` accepted without restriction

### HIGH
2. **INJ-VULN-02**: Command injection via branch field — `$(id)` stored verbatim, executed via `%q` double-quoted strings in Go env script
3. **AUTH-VULN-05**: ACP session heartbeat/status missing project ownership check — any authenticated user can manipulate any session
4. **AUTH-VULN-01**: No rate limiting on bootstrap token endpoint (100+ req/sec confirmed)
5. **SSRF-VULN-03**: GitHub branches API allows querying arbitrary repos via installation token
6. **AUTHZ-VULN-07**: UI governance standards — any user can activate platform-wide standards (no role check)
7. **AUTHZ-VULN-08**: UI governance exceptions — `requestedBy` field never bound to authenticated user
8. **AUTHZ-VULN-09**: UI governance creation endpoints — no role checks on components, compliance runs, migration items
9. **AUTHZ-VULN-10**: UI governance component IDOR — PUT handler lacks ownership check
10. **AUTHZ-VULN-11**: UI governance migration item IDOR — PATCH handler lacks ownership check

## Implementation Checklist

- [ ] **INJ-VULN-03**: Restrict runtime file paths
  - Block absolute paths starting with `/` (except `/home/node/`)
  - Block dangerous `~` paths (`~/.ssh/authorized_keys`, `~/.ssh/authorized_keys2`, `~/.ssh/rc`)
  - Update Go-side validation to match
  - Add tests for blocked and allowed paths

- [ ] **INJ-VULN-02**: Sanitize branch field + fix env script
  - Add branch name validation regex in workspace creation API (alphanumeric, `-`, `_`, `/`, `.`)
  - Fix Go `buildSAMEnvScript()` to use single-quoted values instead of `%q` double-quotes
  - Add tests for injection payloads

- [ ] **AUTHZ-VULN-07-11**: Add role checks to UI governance routes
  - Add `requireSuperadmin()` to all write endpoints (PUT, POST, PATCH)
  - Bind `requestedBy` to authenticated user identity in exception creation
  - Keep read endpoints at `requireApproved()` level
  - Add tests

- [ ] **AUTH-VULN-05**: Add project ownership to ACP heartbeat/status
  - Add nodeId verification in heartbeat handler (matching status handler pattern)
  - Validate session exists and nodeId matches before processing
  - Add tests

- [ ] **AUTH-VULN-01**: Add rate limiting to bootstrap endpoint
  - Apply IP-based rate limiting middleware to `POST /api/bootstrap/:token`
  - Use existing `rateLimit()` middleware with `useIp: true`
  - Add tests

- [ ] **SSRF-VULN-03**: Validate repo ownership in GitHub branches API
  - Verify repository owner matches installation's `accountName`
  - Add tests

- [ ] Write tests for all security fixes
- [ ] Run quality checks (lint, typecheck, test, build)

## Acceptance Criteria

- [ ] All HIGH/CRITICAL vulnerabilities have defensive code changes
- [ ] Tests prove each fix blocks the exploit vector
- [ ] Lint, typecheck, and test suites pass
- [ ] PR created and CI green

## References

- Assessment report: `tasks/backlog/2026-03-12-shannon-security-assessment.md`
- Affected files:
  - `apps/api/src/routes/projects.ts` (runtime files, ACP sessions)
  - `apps/api/src/routes/workspaces.ts` (branch field)
  - `apps/api/src/routes/ui-governance.ts` (auth checks)
  - `apps/api/src/routes/bootstrap.ts` (rate limiting)
  - `apps/api/src/routes/github.ts` (repo validation)
  - `packages/vm-agent/internal/bootstrap/bootstrap.go` (env script, file write)
