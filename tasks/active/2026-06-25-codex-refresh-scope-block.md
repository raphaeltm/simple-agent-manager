# Fix Codex Refresh Scope Validation Default

## Problem

CRED-002 (HIGH, CWE-285/755): Codex OAuth token refresh scope validation currently defaults to warn-and-persist when the upstream rotated token includes an unexpected scope. Rule 28 section 3 requires rotation validation to default to a conservative allowlist, reject unexpected scope changes, and leave the prior credential valid.

Critical constraints:

- Do not deploy to staging.
- Do not merge.
- Stop after a draft PR or pushed branch with `needs-human-review`.

## Research Findings

- `apps/api/src/durable-objects/codex-refresh-lock.ts` validates upstream token response scopes after a successful upstream refresh and before DB persistence.
- The problematic behavior is `this.env.CODEX_SCOPE_VALIDATION_MODE ?? 'warn'`, which logs `codex_refresh.unexpected_scopes_allowed` and then persists rotated tokens.
- `CODEX_EXPECTED_SCOPES` is the allowlist. When unset, code uses `DEFAULT_EXPECTED_SCOPES`; when set to the empty string, validation is explicitly disabled.
- `apps/api/tests/unit/durable-objects/codex-refresh-lock.test.ts` contains tests that currently assert warn-and-persist default behavior and must be updated per Rule 42.
- Rule 28 section 3 requires tests to prove unexpected scope rotations reject, rejected rotations do not persist, unset env uses the conservative allowlist, and `EXPECTED_SCOPES=""` remains an explicit opt-out.

## Implementation Checklist

- [ ] Change Codex scope validation handling so unexpected scopes block by default.
- [ ] Preserve an explicit warning escape hatch only when `CODEX_SCOPE_VALIDATION_MODE=warn`.
- [ ] Preserve `CODEX_EXPECTED_SCOPES=""` as an explicit validation opt-out.
- [ ] Update tests that assert warn-and-persist to assert block-and-not-persist.
- [ ] Add or retain tests for expected-scope success and empty-allowlist opt-out success.
- [ ] Run local API unit tests for `codex-refresh-lock`.
- [ ] Run local quality gates: lint, typecheck, tests, build as feasible.
- [ ] Run local specialist review: security-auditor, cloudflare-specialist, test-engineer, constitution-validator, task-completion-validator.

## Acceptance Criteria

- Unexpected scope on Codex OAuth refresh returns a failure response and does not persist the rotated token by default.
- Prior credential remains valid because no DB update/encryption happens on rejected scope validation.
- Unset `CODEX_EXPECTED_SCOPES` uses the default conservative allowlist, not disabled validation.
- `CODEX_EXPECTED_SCOPES=""` explicitly disables scope validation and allows the refresh.
- No tests assert warn-and-persist as the default desired behavior.

## References

- User task: CRED-002 / idea `01KVZGJNY1FQFQ47TW0MQNVW99`.
- Security review: `/security/SAM-security-review-master-local.md`, Domain B.
- Rule 28: `.claude/rules/28-credential-resolution-fallback-tests.md`.
- Rule 02: `.claude/rules/02-quality-gates.md`.
- Rule 42: do not lock in degraded behavior.
