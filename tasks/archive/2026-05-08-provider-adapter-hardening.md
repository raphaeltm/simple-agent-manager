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

- [x] Add focused runtime response validation helpers in `packages/providers/src/` with explicit `ProviderError` messages and no source-contract tests.
- [x] Apply validation to Hetzner create/get/list responses before mapping them to `VMInstance`.
- [x] Apply validation to Scaleway create/get/list/image responses, preserving the intentional empty-IP-on-create behavior.
- [x] Apply validation to GCP operation, instance, list, and aggregated-list responses before mapping/polling.
- [x] Harden GCP `listVMs()` so only well-understood unavailable/not-found zone cases are tolerated; permission/auth/quota and malformed payload failures must fail fast with context.
- [x] Harden GCP `findInstanceByIdOrName()` so aggregated-list failures are surfaced except for explicitly tolerated not-found/unavailable cases.
- [x] Make GCP firewall source ranges and agent ports explicit `GcpProviderConfig`/constructor options with exported defaults and factory wiring.
- [x] Keep or remove GCP provider firewall creation based on verified caller behavior; if kept, document the security tradeoff and idempotency in code/docs.
- [x] Add tests proving GCP firewall creation uses configured source ranges and ports.
- [x] Address review finding: narrow default GCP VPC firewall source ranges to Cloudflare IPv4 ranges instead of `0.0.0.0/0`.
- [x] Address review finding: resolve Scaleway server zone before get/delete/power lifecycle actions and list across known zones.
- [x] Replace Hetzner fallback randomization with deterministic or injected fallback ordering and update tests to be deterministic.
- [x] Remove every `@typescript-eslint/no-non-null-assertion` warning from `packages/providers/src/**` and `packages/providers/tests/**`.
- [x] Split `packages/providers/tests/unit/hetzner.test.ts` by behavior area or extract focused helpers so files remain within project guidelines.
- [x] Split `packages/providers/tests/unit/scaleway.test.ts` by behavior area or extract focused helpers so files remain within project guidelines.
- [x] Update provider contract tests to support provider-specific IP availability capabilities while preserving core lifecycle guarantees.
- [x] Add or update providerFetch tests if providerFetch behavior is changed, including malformed JSON/error body edge cases. Not touched; validation-level malformed JSON/payload tests added instead.
- [x] Update documentation that references GCP provider configuration/firewall behavior, with code-path citations.
- [x] Run and record provider package `lint`, `typecheck`, and `test`.
- [x] Run and record broader `/do` quality checks. Root `pnpm lint` passed with pre-existing warnings outside `packages/providers`; root `pnpm typecheck` passed; root `pnpm build` passed; root `pnpm test` passed after a targeted quality-gate repair for `apps/api/tests/unit/durable-objects/project-agent.test.ts`; standalone `pnpm --filter @simple-agent-manager/api test` passed. After review fixes, provider `lint`/`typecheck`/`test`, root `lint`, root `typecheck`, root `build`, and root `test` passed again.
- [x] Complete specialist review for infrastructure/security/config/test/docs changes before staging. Review summaries were received from security/BYOC, Constitution/config, documentation sync, and provider test reviewers; security blocking findings C-1 and H-3 were addressed before staging.
- [ ] Deploy the branch to staging via GitHub Actions and verify the changed provider path as far as staging credentials allow. Blocked: staging workflow run `25535524173` failed at `Deploy API Worker` with Cloudflare Wrangler error `10074` (`ProjectData` `new_sqlite_class` migration already depended on by existing Durable Objects). Filed `tasks/backlog/2026-05-08-staging-projectdata-sqlite-migration-blocker.md`; PR must be labeled/commented `needs-human-review` and must not merge.

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
