# Harden callback/bootstrap token lifecycle

## Problem

Recent audits found that VM callback/bootstrap credentials still have lifecycle and exposure risks:

- callback tokens may be exposed through cloud-init or systemd environment material;
- bootstrap-token legacy plaintext compatibility may be too broad or unobservable;
- callback/bootstrap token TTL and auth behavior need stronger regression coverage.

The remediation must be tightly scoped and non-breaking. Existing provisioned nodes and in-flight provisioning must keep working. If any legacy path must remain, it must be bounded, observable, and fail closed where safe.

## Research findings

- `packages/shared/src/types/workspace.ts` defines `BootstrapTokenData.callbackToken` as deprecated legacy plaintext compatibility and newer `encryptedCallbackToken` / `callbackTokenIv` fields.
- `packages/shared/src/vm-agent-contract.ts` defines `DEFAULT_CALLBACK_TOKEN_EXPIRY_MS` as 24 hours and callback JWT audience constants.
- `.claude/rules/34-vm-agent-callback-auth.md` documents repeated production failures from mounting VM callback routes behind session-cookie middleware; callback routes must use bearer callback JWT auth and be mounted before session-auth routes.
- Public docs live under `apps/www/src/content/docs/docs/`; repo markdown is not public user documentation unless it is part of this docs tree.
- Relevant backlog follow-ups already exist for related security themes, including callback-scope enforcement and legacy callback fallback removal; this task should implement the narrow safe slice, not prematurely remove compatibility that could strand nodes.

## Checklist

- [x] Inspect cloud-init templates and generated systemd units for callback/bootstrap token exposure.
- [x] Inspect API bootstrap token creation/redeem paths, TTL configuration, encryption, and legacy fallback.
- [x] Inspect callback auth routes and tests for bearer token validation and scope/audience checks.
- [ ] Implement narrow non-breaking hardening:
  - [x] remove callback/bootstrap tokens from systemd environment or durable logs for new nodes;
  - [x] keep necessary legacy compatibility only for unexpired in-flight bootstrap tokens;
  - [x] add observable diagnostics for legacy plaintext fallback without logging token material;
  - [x] fail closed for expired, malformed, or unauthorized callback/bootstrap token use.
- [ ] Add tests covering:
  - [x] bootstrap token TTL and expiry rejection;
  - [x] encrypted callback-token redemption;
  - [x] bounded legacy plaintext callback-token compatibility;
  - [x] cloud-init/systemd redaction and non-exposure of callback/bootstrap tokens;
  - [x] callback auth behavior for valid, invalid, expired, and wrong-audience tokens.
- [x] Update public docs if operator-visible behavior or follow-up guidance changes.
- [ ] Run relevant checks: lint, typecheck, targeted tests, full root quality suite where feasible.
- [ ] Run local specialist reviews: security-auditor, cloudflare-specialist if API touched, go-specialist if Go touched, env-validator, doc-sync-validator, constitution-validator, test-engineer, task-completion-validator.
- [ ] Deploy to staging and provision a real VM; verify VM agent heartbeat, workspace reachability, and cleanup.
- [ ] Create PR against `main`, state no breaking changes, include test/staging/VM evidence, and do not merge.

## Acceptance criteria

- New VM provisioning does not expose callback/bootstrap tokens through systemd environment or logs.
- Existing provisioned nodes and unexpired in-flight provisioning remain compatible.
- Legacy plaintext callback-token compatibility is bounded to valid unexpired bootstrap records, observable without token material, and rejected after expiry.
- Callback JWT routes remain protected by bearer callback auth with proper failure behavior.
- Tests cover TTL, legacy compatibility bounds, token redaction/non-exposure, and callback auth behavior.
- PR is open with CI evidence and no merge is performed.

## References

- Audit task 01KXT1F6JSDV3J5CJ22TGXRGAV
- Audit task 01KXT25E7FSNR952HMGACHSQE9
- Audit task 01KXT1E0Z1GNCNQ5HYZVE67SB5
- Sessions: `fd408b7a-4b2e-4684-a290-285d03a88d63`, `14d1b5ba-f76e-4f21-9d54-324a8095a486`, `7cc1c359-cc3f-4d8c-96ed-2a2b6c69d70c`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/29-local-first-debugging.md`
- `.github/pull_request_template.md`
