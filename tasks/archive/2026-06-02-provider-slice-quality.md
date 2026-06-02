# Provider Slice Quality Fix

## Problem

The provider package has two CTO spot-check findings:

- `ScalewayProvider.createVM` creates a paid server before uploading cloud-init user data and powering the server on. If either post-create step fails, the method currently throws and leaves an incomplete server behind.
- `HetznerProvider` logs retry and fallback state through raw `console.*`, which makes production logging uncontrolled and tests dependent on global console spies.

## Research Findings

- Affected files are expected to be limited to `packages/providers/src/scaleway.ts`, `packages/providers/src/hetzner.ts`, `packages/providers/src/types.ts`, `packages/providers/src/index.ts`, and targeted unit tests under `packages/providers/tests/unit/`.
- `ProviderError` already has JSON serialization tests in `packages/providers/tests/unit/provider-error-tojson.test.ts`; cleanup diagnostics should fit the existing contract or extend it narrowly.
- Relevant rules:
  - `.claude/rules/02-quality-gates.md` requires regression tests and a task-record post-mortem for bug fixes.
  - `.claude/rules/19-external-service-integration.md` applies because provider code talks to external cloud APIs; changes should keep secrets out of logs/errors and use realistic mocked provider boundaries.
  - `.claude/rules/22-infrastructure-merge-gate.md` requires live VM provisioning only for cloud-init templates, VM agent, DNS, TLS, or deployment infrastructure changes. This task should be package-level provider behavior only, so mocked package tests should be sufficient unless the diff expands.

## Post-Mortem

### What Broke

`ScalewayProvider.createVM` can leave a paid provider server behind when a post-create step fails. `HetznerProvider` emits provider retry/fallback state with uncontrolled `console.*`.

### Root Cause

The create lifecycle treated server creation, cloud-init upload, and power-on as a linear sequence without a compensating action boundary after the external resource was allocated. Hetzner logging was implemented as direct console calls instead of a controlled dependency.

### Timeline

The issue was discovered during a CTO-level provider-slice spot check after unrelated spot-check branches on 2026-05-31 and 2026-06-01.

### Why It Wasn't Caught

Existing tests covered successful provider behavior and common error paths but did not assert cleanup side effects after partial external resource creation. Logging tests tolerated global console behavior instead of asserting a provider-controlled logging contract.

### Class Of Bug

External-resource lifecycle hygiene and observability boundary drift: mocks verified request success/failure but not the cleanup/diagnostic contract required when an allocated cloud resource becomes partially configured.

### Process Fix

Add focused regression tests that fail if a provider create flow does not clean up after post-allocation failure, and keep provider logs behind injectable no-op-by-default boundaries.

## Implementation Checklist

- [x] Inspect Scaleway create/delete lifecycle and ProviderError serialization.
- [x] Add a small Scaleway cleanup helper that deletes or terminates a known zone/server id and tolerates 404.
- [x] Use the helper after cloud-init upload failure and poweron failure while preserving the original failure as the primary error.
- [x] Represent cleanup failure diagnostics in a safe, deterministic ProviderError shape.
- [x] Add Scaleway tests for cloud-init failure cleanup, poweron failure cleanup, cleanup failure visibility, and unchanged success behavior.
- [x] Replace Hetzner raw `console.*` usage with an injectable no-op-by-default logger.
- [x] Update Hetzner tests to assert logging through the injected logger rather than global console spies.
- [x] Run provider package tests and available typecheck/build/lint checks.
- [ ] Run specialist validation for task completion, tests, security/secrets, and constitution compliance.

## Acceptance Criteria

- Scaleway post-create cloud-init failure attempts cleanup of the created server and rejects with the original cloud-init failure.
- Scaleway post-create poweron failure attempts cleanup of the created server and rejects with the original poweron failure.
- Scaleway cleanup failure does not suppress the original failure and is inspectable through `ProviderError` cause/context/toJSON.
- Cleanup tolerates provider 404 responses.
- Hetzner provider logs only through an injectable logger that defaults to no-op.
- Tests do not depend on uncontrolled global console logging.
- Package-level validation passes.
- No provider secrets are logged or serialized in added diagnostics.

## References

- `packages/providers/src/scaleway.ts`
- `packages/providers/src/hetzner.ts`
- `packages/providers/src/provider-fetch.ts`
- `packages/providers/src/types.ts`
- `packages/providers/src/index.ts`
- `packages/providers/tests/unit/scaleway.test.ts`
- `packages/providers/tests/unit/scaleway-lifecycle.test.ts`
- `packages/providers/tests/unit/hetzner.test.ts`
- `packages/providers/tests/unit/provider-error-tojson.test.ts`
