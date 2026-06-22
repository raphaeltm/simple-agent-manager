# Enforce Semantic Validation in Resolve Manifest

## Problem Statement

`resolveManifest()` returns a `ComposeResolveResult` whose success branch contains a `DeploymentManifest`, but it currently validates the resolved object only with `DeploymentManifestSchema.safeParse()`. That proves shape and type validity, but it bypasses the canonical `validateManifest()` semantic phase for cross-references.

As a result, callers that construct or mutate an `UnresolvedManifest` directly can receive `success: true` for a manifest with routes pointing to missing services, service mounts pointing to undeclared volumes, or pre-flight hooks targeting missing services.

## Research Findings

- `packages/shared/src/compose-parser/resolve.ts` builds a resolved object, then calls `DeploymentManifestSchema.safeParse(resolved)`.
- `packages/shared/src/deployment-manifest/validate.ts` deliberately centralizes canonical validation in `validateManifest()`: dangerous Compose field detection, Zod shape validation, then semantic cross-reference validation.
- The relevant semantic checks are route-to-service, service-volume-to-declared-volume, and preFlight-hook-to-service references.
- `parseCompose()` already rejects the relevant cases for normal YAML input, so resolver regression tests need to construct or intentionally mutate `UnresolvedManifest` objects and call `resolveManifest()` directly.
- `packages/shared/tests/unit/compose-round-trip.test.ts` has stale wording that says resolver success proves `DeploymentManifestSchema`/Zod validation. The resolver should instead prove canonical deployment-manifest validation.
- Prior task `tasks/archive/2026-06-11-compose-subset-parser.md` shows the original resolver checklist explicitly stopped at `DeploymentManifestSchema`, which explains why semantic resolver coverage was missed.
- Public app deployment docs describe Compose YAML as the release submission format and raw manifest JSON as backward-compatible, reinforcing that shared manifest validation is an execution-contract boundary.
- Rule 02 requires bug-fix task records to include post-mortem/process-fix analysis and tests that would catch the original regression.

## Implementation Checklist

- [x] Update `packages/shared/src/compose-parser/resolve.ts` to use canonical `validateManifest()` for the final resolved object.
- [x] Preserve the existing `ComposeResolveResult` error shape and path/message formatting.
- [x] Add focused resolver regression tests for route references to missing services.
- [x] Add focused resolver regression tests for service volumes referencing missing top-level volumes.
- [x] Add focused resolver regression tests for preFlight hooks referencing missing services.
- [x] Update stale round-trip test naming/comment language to describe canonical deployment-manifest validation, including semantic cross-reference validation.
- [x] Add the required bug-fix post-mortem/process-fix record for this validation-boundary bug.
- [x] Run `pnpm --filter @simple-agent-manager/shared test -- deployment-manifest compose-parser compose-round-trip`.
- [x] Run `pnpm --filter @simple-agent-manager/shared lint`.
- [x] Run `pnpm --filter @simple-agent-manager/shared typecheck`.

## Acceptance Criteria

- `resolveManifest()` rejects semantically invalid resolved manifests even when their object shape passes Zod validation.
- Regression tests fail against the old schema-only resolver behavior and pass after the fix.
- Existing parser and deployment-manifest tests continue to pass.
- Error paths/messages remain structured as `{ path, message }` and match canonical `validateManifest()` output.
- The round-trip test language no longer implies Zod-only validation is the full contract.

## Post-Mortem

### What Broke

The exported resolver could return `success: true` for a manifest that violated deployment-manifest cross-reference invariants.

### Root Cause

The original Compose subset parser implementation validated the resolver output through `DeploymentManifestSchema.safeParse()` instead of the canonical `validateManifest()` helper, even though semantic validation intentionally lives outside the Zod schema.

### Timeline

- 2026-06-11: Compose subset parser task implemented resolver output validation against `DeploymentManifestSchema`.
- 2026-06-22: CTO spot-check identified that resolver callers can bypass semantic validation by calling `resolveManifest()` directly with constructed or mutated `UnresolvedManifest` objects.

### Why It Was Not Caught

Tests covered parser-produced Compose input and deployment-manifest validation independently, but no test exercised the exported resolver as its own trust boundary with semantically invalid but schema-shaped input.

### Class of Bug

Validation boundary drift: an exported helper promises a canonical domain type but calls a lower-level structural validator instead of the canonical semantic validator.

### Process Fix

For exported helpers that return canonical domain types, tests should include direct malformed-domain inputs that pass structural validation but fail semantic validation. Reviewers should reject schema-only checks when the codebase has a canonical validation helper for the same domain contract.

## References

- `packages/shared/src/deployment-manifest/schema.ts`
- `packages/shared/src/deployment-manifest/validate.ts`
- `packages/shared/src/compose-parser/resolve.ts`
- `packages/shared/tests/unit/deployment-manifest.test.ts`
- `packages/shared/tests/unit/compose-parser.test.ts`
- `packages/shared/tests/unit/compose-round-trip.test.ts`
- `tasks/archive/2026-06-11-compose-subset-parser.md`
- `.claude/rules/02-quality-gates.md`
