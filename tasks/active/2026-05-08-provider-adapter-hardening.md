# Provider Adapter Hardening

## Problem

The `packages/providers` package is part of SAM's infrastructure provisioning path, but current provider adapters trust cloud API response payloads too much, normalize lint warnings, and hide some provider failures. A spot check on 2026-05-08 found that the package tests, typecheck, and lint pass, but lint only passes with 56 non-null assertion warnings and two provider test files exceed the repository file-size guideline.

This does not meet the quality bar for infrastructure software. Malformed provider responses should fail fast with actionable provider context, configurable security defaults should be explicit, and test structure should make provider behavior easy to review.

## Research Findings

- `packages/providers/src/gcp.ts` casts operation, instance, and list JSON payloads directly to internal interfaces. `listVMs()` catches every zone error and returns partial data, and `findInstanceByIdOrName()` swallows aggregated-list failures.
- `packages/providers/src/gcp.ts` creates a project-level firewall rule named `sam-allow-agent` with hardcoded ports `['8080', '8443']` and `sourceRanges: ['0.0.0.0/0']`. The GCP setup docs list configurable GCP VM provisioning values but do not describe this firewall behavior.
- `docs/architecture/walkthrough.md` documents OS-level firewalling via cloud-init that restricts VM agent access to Cloudflare IP ranges. The GCP provider firewall rule therefore needs an explicit, documented security tradeoff if it remains in the provider package.
- `packages/providers/src/hetzner.ts` builds fallback placement order with `.sort(() => Math.random() - 0.5)`, making placement behavior nondeterministic in production and tests.
- `packages/providers/src/scaleway.ts` casts create/get/list/image responses directly. Scaleway creation intentionally returns an empty `ip` because IP backfill happens from VM heartbeat after boot.
- `packages/providers/src/provider-fetch.ts` wraps provider HTTP errors and timeouts, but any changes to JSON/error body parsing need regression tests and must avoid leaking tokens from headers or URLs.
- `packages/providers/tests/contract/provider-contract.test.ts` assumes `createVM()` returns a truthy IP for all providers, which conflicts with the Scaleway lifecycle.
- `packages/providers/tests/unit/hetzner.test.ts` and `packages/providers/tests/unit/scaleway.test.ts` are each 593 lines, exceeding the repo guideline and making review harder.
- Valibot exists elsewhere in the monorepo, but `@simple-agent-manager/providers` does not currently depend on it. A small local validator avoids adding a package dependency unless a stronger reason appears during implementation.
- Relevant process lessons:
  - `docs/notes/2026-03-14-scaleway-node-creation-failure-postmortem.md`: research findings must become checklist items and provider selection/error context must be verified end-to-end.
  - `docs/notes/2026-03-24-gcp-oidc-review-postmortem.md`: external cloud-provider integrations need design review from a self-hoster/security perspective, not just spec matching.
  - `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`: staging verification for infrastructure-sensitive changes must exercise real VM provisioning and heartbeat when the changed path can affect VM boot/access.
- Constitution checks:
  - Principle II requires robust provider API tests for critical VM provisioning paths.
  - Principle XI allows default constants only when configuration can override them.
  - Principle XIII requires fail-fast rejection at boundaries instead of silent invalid state.

## Implementation Checklist

- [ ] Add focused runtime response validation helpers in `packages/providers/src/` with explicit `ProviderError` messages and no source-contract tests.
- [ ] Apply validation to Hetzner create/get/list responses before mapping them to `VMInstance`.
- [ ] Apply validation to Scaleway create/get/list/image responses, preserving the intentional empty-IP-on-create behavior.
- [ ] Apply validation to GCP operation, instance, list, and aggregated-list responses before mapping/polling.
- [ ] Harden GCP `listVMs()` so only well-understood unavailable/not-found zone cases are tolerated; permission/auth/quota and malformed payload failures must fail fast with context.
- [ ] Harden GCP `findInstanceByIdOrName()` so aggregated-list failures are surfaced except for explicitly tolerated not-found/unavailable cases.
- [ ] Make GCP firewall source ranges and agent ports explicit `GcpProviderConfig`/constructor options with exported defaults and factory wiring.
- [ ] Keep or remove GCP provider firewall creation based on verified caller behavior; if kept, document the security tradeoff and idempotency in code/docs.
- [ ] Add tests proving GCP firewall creation uses configured source ranges and ports.
- [ ] Replace Hetzner fallback randomization with deterministic or injected fallback ordering and update tests to be deterministic.
- [ ] Remove every `@typescript-eslint/no-non-null-assertion` warning from `packages/providers/src/**` and `packages/providers/tests/**`.
- [ ] Split `packages/providers/tests/unit/hetzner.test.ts` by behavior area or extract focused helpers so files remain within project guidelines.
- [ ] Split `packages/providers/tests/unit/scaleway.test.ts` by behavior area or extract focused helpers so files remain within project guidelines.
- [ ] Update provider contract tests to support provider-specific IP availability capabilities while preserving core lifecycle guarantees.
- [ ] Add or update providerFetch tests if providerFetch behavior is changed, including malformed JSON/error body cases.
- [ ] Update documentation that references GCP provider configuration/firewall behavior, with code-path citations.
- [ ] Run and record provider package `lint`, `typecheck`, and `test`.
- [ ] Run and record broader `/do` quality checks.
- [ ] Complete specialist review for infrastructure/security/config/test/docs changes before staging.
- [ ] Deploy the branch to staging via GitHub Actions and verify the changed provider path as far as staging credentials allow. If exact GCP/Scaleway verification is blocked by missing credentials/provider availability, comment on the PR, label it `needs-human-review`, notify the human, and do not merge.

## Acceptance Criteria

- Provider adapters reject malformed required cloud API response fields with actionable `ProviderError` context instead of mapping undefined/null values into `VMInstance`.
- GCP firewall source ranges and agent ports are explicit configuration with documented defaults; tests prove the configured values reach the firewall API payload.
- GCP list/find operations fail fast for credential, permission, quota, transport, and malformed-payload failures, while preserving only explicit not-found/unavailable-zone tolerance.
- Hetzner placement fallback behavior is deterministic or explicitly injected and covered by deterministic tests.
- `pnpm --filter @simple-agent-manager/providers lint` reports no non-null assertion warnings for provider source/tests.
- `pnpm --filter @simple-agent-manager/providers typecheck` passes.
- `pnpm --filter @simple-agent-manager/providers test` passes with behavior coverage at least equivalent to the baseline.
- `packages/providers/tests/unit/hetzner.test.ts` and `packages/providers/tests/unit/scaleway.test.ts` no longer exceed the project file-size guideline.
- Provider contract tests allow Scaleway's documented empty create IP without weakening required identity/status/type/label lifecycle assertions.
- BYOC boundaries remain intact: provider constructors receive explicit credentials/config and do not read `process.env`.
- Documentation is synchronized with any changed provider behavior and cites relevant code paths.
- A PR is pushed on `sam/use-skill-end-end-01kr2p`; it is not merged unless Raphaël explicitly asks.

## References

- `packages/providers/src/gcp.ts`
- `packages/providers/src/hetzner.ts`
- `packages/providers/src/scaleway.ts`
- `packages/providers/src/provider-fetch.ts`
- `packages/providers/tests/contract/provider-contract.test.ts`
- `docs/guides/gcp-setup.md`
- `docs/architecture/walkthrough.md`
- `.specify/memory/constitution.md`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/13-staging-verification.md`
