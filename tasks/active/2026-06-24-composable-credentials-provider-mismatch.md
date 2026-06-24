# Remediate composable-credentials compute provider mismatch

## Problem

The shared composable-credentials compute boundary can silently assemble an internally inconsistent provider config. A `compute:hetzner` resolution can return a `cloud-provider` credential whose decrypted secret says `provider: "scaleway"`. `computeAssembler` currently trusts the secret provider/token pair instead of enforcing that the secret provider matches `resolved.consumer.provider`.

In the API path, `createProviderForUser(..., targetProvider)` constructs provider clients using the requested target provider while consuming `ccConfig.token`. A mismatch can therefore pass a Scaleway token into a Hetzner client. Credential boundary code must reject this loudly.

## Research Findings

- `packages/shared/src/composable-credentials/assemblers.ts` is the shared consumer-specific assembly boundary. `computeAssembler` already rejects non-compute consumers, missing credentials, and non-`cloud-provider` secrets, but does not compare `resolved.consumer.provider` with `secret.provider`.
- `packages/shared/src/composable-credentials/resolver.ts` keys resolution by `ConsumerRef`, including `compute:<provider>`, and returns the requested consumer on `ResolvedEnvironment`. The assembler has enough context to validate provider consistency.
- `apps/api/src/services/composable-credentials/resolve.ts` delegates `resolveComputeConfig` to shared `computeAssembler`.
- `apps/api/src/services/provider-credentials.ts` calls `resolveComputeConfig(..., targetProvider)` and then uses `targetProvider` as the provider name for `buildProviderConfig`, so the API path depends on `resolveComputeConfig` not returning mismatched token material.
- `packages/shared/tests/unit/composable-credentials-experiment.test.ts` and `packages/shared/tests/unit/composable-credentials-wiring-parity.test.ts` still use `EXPERIMENT`/`E*` naming for production behavior and use several non-null assertions.
- `packages/shared/tests/unit/composable-credentials-wiring-parity.test.ts` manually constructs impossible `ResolvedEnvironment` values with `credential: null as never` or missing `consumer`. Those branches should be tested with realistic resolver output or removed from shared mapper tests.
- Existing API worker coverage in `apps/api/tests/workers/composable-credentials-wiring.test.ts` already exercises `createProviderForUser` through realistic D1 state and is the best place for a vertical-ish API/shared regression.
- Relevant prior incident: `tasks/archive/2026-06-14-cc-platform-default-short-circuit.md` documents a composable-credentials rollback caused by a platform default silently short-circuiting user credentials. The shared failure class is silent acceptance at a credential trust boundary.
- Relevant rules: `.claude/rules/02-quality-gates.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/41-credential-snapshot-resilience.md`.

## Implementation Checklist

- [ ] Add a shared regression proving `computeAssembler` rejects a `cloud-provider` credential whose `secret.provider` differs from the requested `resolved.consumer.provider`.
- [ ] Update `computeAssembler` to enforce provider consistency and throw a clear error containing both the requested consumer provider and credential provider.
- [ ] Preserve existing `computeAssembler` behavior for non-compute consumers, null credentials, and non-cloud-provider credentials.
- [ ] Add a vertical-ish API/shared regression around `createProviderForUser` or `resolveComputeConfig` proving a mismatched CC provider cannot flow into provider creation.
- [ ] Reframe touched `composable-credentials-*` tests away from `EXPERIMENT`/`E*` naming and comments.
- [ ] Remove impossible manually-cast `ResolvedEnvironment` objects from touched shared tests.
- [ ] Replace non-null assertions in touched shared composable-credentials tests with focused helper assertions where reasonable.
- [ ] Add a process-fix rule/checklist update for provider-name consistency at composable-credentials compute boundaries.
- [ ] Run focused validation:
  - `pnpm --filter @simple-agent-manager/shared test -- composable-credentials`
  - `pnpm --filter @simple-agent-manager/shared typecheck`
  - `pnpm --filter @simple-agent-manager/shared lint`
  - focused API worker/unit test if API tests are touched
- [ ] Run required specialist validation for credential/security/test changes before PR.

## Acceptance Criteria

- A mismatched requested compute provider and cloud-provider secret provider throws before a provider client can be built.
- The thrown error names both the requested provider and the credential provider.
- Existing valid compute provider assembly and agent assembly behavior remains unchanged.
- Touched shared tests describe production contracts, not experiments.
- Touched shared tests avoid impossible domain objects and reduce `resolved!`/`legacy!` style assertions in favor of clear helper failures.
- API/shared regression proves the mismatch is blocked on the provider creation path.
- Focused shared validation passes; focused API validation passes if API tests are changed.

## Post-Mortem

### What broke

The compute composable-credentials boundary accepted a configuration whose consumer requested one cloud provider while the decrypted credential secret named another provider.

### Root cause

The resolver correctly carried both the requested consumer and the credential, but `computeAssembler` returned the credential provider/token without checking that the two provider identifiers matched.

### Timeline

Composable credentials moved into production paths before this spot-check on 2026-06-24. Existing focused tests covered happy-path compute resolution and assembly but not inconsistent provider material.

### Why it was not caught

The tests proved that valid provider tokens flow through, but did not assert the semantic invariant that a compute consumer and a `cloud-provider` secret must agree on provider identity. Some shared tests also used experiment-era naming and impossible hand-built `ResolvedEnvironment` objects, which made boundary contracts less explicit.

### Class of Bug

Silent acceptance at a credential trust boundary: two independently supplied identity fields are both present, but the boundary fails to reject disagreement.

### Process Fix

Update credential-resolution rules to require provider/dialect identity consistency tests where a resolved consumer and credential secret both name the downstream provider or dialect.

## References

- `packages/shared/src/composable-credentials/assemblers.ts`
- `packages/shared/src/composable-credentials/resolver.ts`
- `packages/shared/tests/unit/composable-credentials-experiment.test.ts`
- `packages/shared/tests/unit/composable-credentials-wiring-parity.test.ts`
- `apps/api/src/services/composable-credentials/resolve.ts`
- `apps/api/src/services/provider-credentials.ts`
- `apps/api/tests/workers/composable-credentials-wiring.test.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/41-credential-snapshot-resilience.md`
- `tasks/archive/2026-06-14-cc-platform-default-short-circuit.md`
