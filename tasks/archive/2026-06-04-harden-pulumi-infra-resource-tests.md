# Harden Pulumi Infra Resource Tests Around Cloudflare Invariants

## Problem

The Pulumi infrastructure resource tests under `infra/__tests__/` mostly assert that exported values exist. They do not protect critical Cloudflare invariants for DNS routing, Pages DNS targets, D1/KV/R2 naming and account wiring, protected generated secrets, or Origin CA TLS settings. Future edits could break deployment, routing, credential durability, or VM TLS behavior while the current tests still pass.

## Research Findings

- `infra/resources/dns.ts` creates API/app/wildcard DNS records and a same-zone VM route exclusion. Tests need to inspect Pulumi resource inputs and ensure the VM exclusion pattern omits `scriptName`.
- `infra/resources/database.ts`, `kv.ts`, and `storage.ts` create D1, KV, and R2 resources with Cloudflare account and naming conventions that should be asserted directly.
- `infra/resources/secrets.ts` generates encryption, JWT, and trial secrets using Pulumi-managed random/tls resources. Tests should protect byte lengths, RSA settings, `protect` options, and secret output status.
- `infra/resources/origin-ca.ts` generates long-lived RSA Origin CA TLS assets for base and VM wildcard hostnames. Tests should assert CSR/cert invariants and protection settings.
- `infra/__tests__/setup.ts` mocks Pulumi but does not expose resource registrations/options clearly enough for targeted assertions.
- Relevant rules: `.claude/rules/14-do-workflow-persistence.md`, `.claude/rules/13-staging-verification.md`, `.claude/rules/22-infrastructure-merge-gate.md`, and `.claude/rules/02-quality-gates.md`.
- Relevant retained lesson: `tasks/archive/2026-03-30-fix-r2-upload-cors.md` documents infrastructure checklist items being missed because tests did not protect real deployment dependencies.

## Checklist

- [x] Improve `infra/__tests__/setup.ts` with deterministic helpers to inspect Pulumi `newResource` registrations, options, and output values without logging secrets.
- [x] Harden DNS tests for API/wildcard CNAME records, Pages subdomain target, VM route exclusion pattern with no `scriptName`, and exported hostnames.
- [x] Harden D1 tests for database names, account ID wiring, observability naming, and `ignoreChanges: ["readReplication"]`.
- [x] Harden KV tests for session namespace title and account ID wiring.
- [x] Harden R2 tests for bucket name, account ID wiring, and default location.
- [x] Add security resource tests for RandomId byte lengths, RSA key settings, protect flags, and secret outputs.
- [x] Add Origin CA tests for RSA private key, CSR hostnames, cert hostnames/request type/validity/protection, and secret outputs.
- [x] Keep production changes minimal; if tests reveal actual defects, fix them directly and note the reason.
- [x] Run `pnpm --dir infra test`.
- [x] Run `pnpm --dir infra typecheck`.
- [x] Run repository-level quality checks required by the `/do` workflow for this scope.
- [x] Run final read-only `$cloudflare-specialist` review and address any findings.
- [x] Open a PR whose description states this is infrastructure test hardening, not a functional resource change unless functional fixes are discovered.
- [x] Complete required staging/infrastructure verification or document any credential/configuration blocker without merging.

## Acceptance Criteria

- Infra tests fail if critical Cloudflare routing, naming, protection, or secret-output invariants are removed.
- Pulumi test helpers remain readable and reusable without broad snapshots.
- No secret material is printed or committed.
- `pnpm --dir infra test` and `pnpm --dir infra typecheck` pass.
- PR description explicitly calls out infrastructure test hardening and any functional resource changes, if discovered.
