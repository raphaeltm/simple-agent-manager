# Cloud-init validation hardening

## Problem

A CTO-level spot check of the cloud-init VM provisioning template slice found that the package is well covered but still falls short of the required quality bar for a critical boot path. Several environment-fed values are embedded into shell, systemd, or JSON contexts and the validator does not fully enforce the contracts documented by the code.

## Research findings

- `packages/cloud-init/src/generate.ts` validates most shell-embedded fields before applying `CLOUD_INIT_TEMPLATE`.
- `devcontainerCacheEnabled` is passed from `apps/api/src/services/nodes.ts` via `env.DEVCONTAINER_CACHE_ENABLED` into `Environment=DEVCONTAINER_CACHE_ENABLED={{ devcontainer_cache_enabled }}` but is not validated.
- `cfIpFetchTimeout` is documented as a positive integer, but `0` currently passes validation and is injected into `curl --max-time`.
- `dockerDnsServers` only checks quoted dotted-decimal shape and accepts invalid octets such as `"999.999.999.999"`, despite being emitted into Docker daemon JSON.
- `packages/cloud-init/tests/generate.test.ts` has strong YAML parsing and security regression coverage, so this fix should extend that coverage rather than introduce a new test style.

## Checklist

- [x] Add boolean validation for `devcontainerCacheEnabled`.
- [x] Tighten `cfIpFetchTimeout` to require an integer greater than zero.
- [x] Tighten Docker DNS server validation to parse the configured JSON fragment and enforce valid IPv4 octets.
- [x] Add regression tests for the validation gaps.
- [x] Run focused package tests, typecheck, and build.

## Acceptance criteria

- Invalid `DEVCONTAINER_CACHE_ENABLED` values are rejected before cloud-init generation.
- `cfIpFetchTimeout: "0"` is rejected.
- Invalid Docker DNS octets are rejected while valid one- and two-server configurations still pass.
- Existing cloud-init YAML round-trip and security tests remain green.
