# Harden Pulumi Infra Resource Configuration

## Problem

The Pulumi infra resource slice currently bakes deployment policy into resource constructors and silently tolerates missing required configuration in shared helpers. That fails the CTO spot-check bar for production infrastructure: resources must be configurable, fail fast on invalid deployment settings, preserve existing defaults, and have tests that exercise resource contracts rather than only export presence.

## Research Findings

- `infra/resources/storage.ts` hardcodes R2 `location: "WNAM"` directly in the bucket args. R2 location is a deployment policy and needs a typed config accessor with an explicit `WNAM` default and validation against Cloudflare-supported values.
- `infra/resources/pages.ts` hardcodes `productionBranch: "main"`. The branch is fork/deployment policy and needs a config value with a `main` default and non-empty validation.
- `infra/resources/config.ts` exports `cloudflareZoneId` and `baseDomain` as `pulumiConfig.get(...) || ""`, so modules imported in isolation can construct DNS/Page resources with empty required inputs.
- `infra/resources/origin-ca.ts` and `infra/index.ts` independently read `baseDomain` with a separate `new pulumi.Config()`, duplicating required config behavior instead of sharing the central parser.
- `infra/__tests__/storage.test.ts` currently locks in hardcoded `WNAM` and includes low-value presence checks instead of proving default, override, and invalid-config behavior.
- `infra/__tests__/kv.test.ts` and nearby tests still include presence/export checks that provide little confidence compared with existing DNS and Origin CA tests, which assert resource inputs, Pulumi options, and secret marking.
- `infra/__tests__/setup.ts` records Pulumi resources and seeds test config, which is useful for resource contract assertions. Config validation should use pure helpers so invalid/missing cases can be tested without fragile module-cache resets.

## Implementation Checklist

- [x] Add typed config parsing helpers in `infra/resources/config.ts` for required strings, optional strings, R2 location, and Pages production branch.
- [x] Export explicit defaults and supported R2 location values while preserving current behavior: R2 defaults to `WNAM`; Pages production branch defaults to `main`.
- [x] Replace empty-string fallbacks for `baseDomain` and `cloudflareZoneId` with fail-fast required config parsing.
- [x] Wire the configurable R2 location into `infra/resources/storage.ts`.
- [x] Wire the configurable Pages production branch into `infra/resources/pages.ts`.
- [x] Update `infra/resources/origin-ca.ts` and `infra/index.ts` to consume central config exports instead of duplicate `new pulumi.Config()` reads.
- [x] Add config helper tests for default, override, blank, missing, and unsupported values.
- [x] Refactor storage tests to assert bucket inputs, output contract, default location, override location, and invalid location failure before resource creation.
- [x] Refactor Pages tests to assert project/domain inputs, default branch, override branch, and blank branch failure.
- [x] Refactor KV/database-style low-value presence tests toward resource contract assertions and exported output behavior.
- [x] Run `pnpm --filter @simple-agent-manager/infra test`.
- [x] Run `pnpm --filter @simple-agent-manager/infra typecheck`.
- [x] Run relevant broader quality checks if touched files require them.
- [x] Complete specialist validation for Cloudflare/Pulumi resource behavior, Principle XI compliance, test quality, and task completion before archiving.

## Acceptance Criteria

- R2 bucket location is read from Pulumi config with an explicit `WNAM` default and accepts only `WNAM`, `ENAM`, `WEUR`, `EEUR`, `APAC`, or `OC`.
- Unsupported R2 location values fail deterministically before any R2 bucket resource is registered.
- Pages production branch is read from Pulumi config with an explicit `main` default and rejects missing/blank override values.
- `baseDomain` and `cloudflareZoneId` fail fast when missing or blank for modules that depend on DNS/Page/domain configuration.
- Existing resource names and default production behavior remain stable.
- Tests cover resource inputs, Pulumi options, exported outputs consumed by deployment scripts, secret marking where applicable, config defaults, overrides, and invalid-config failure modes.
- Infra test and typecheck commands pass.

## PR & Staging Evidence

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1333.
- Staging deploy: https://github.com/raphaeltm/simple-agent-manager/actions/runs/27590612543 passed for `sam/remediate-cto-spot-check-01kv74`.
- Direct staging checks passed: R2 bucket `sam-staging-assets` reports `location: WNAM`; DNS records target staging Workers/Pages hosts; API health returned HTTP 200 healthy; D1 counts returned users=4, projects=25, tasks=142, nodes=61, workspaces=101.
- GitHub staging Playwright smoke-tests passed in the deploy workflow. A local rerun was attempted, but local browser checks could not launch because Chromium was missing from the local Playwright cache; the install hung after download and was terminated.
