# Configurable Swap File Support in Cloud-Init

## Problem Statement

PR #1118 (branch `lio/swap`) attempted to add swap file configuration to VMs but had critical issues:
1. Modified the wrong file (`scripts/vm/cloud-init.yaml` — a reference template, not the production path)
2. Added `HETZNER_TOKEN` to the VM filesystem, violating the BYOC security model
3. Hardcoded 4GB swap size, violating Constitution Principle XI (no hardcoded values)

The production cloud-init path (`packages/cloud-init/src/template.ts` + `generate.ts`) was untouched.

## Research Findings

### Production cloud-init path
- `packages/cloud-init/src/template.ts` — `CLOUD_INIT_TEMPLATE` string literal with `{{ placeholder }}` variables
- `packages/cloud-init/src/generate.ts` — `generateCloudInit()` performs validation + replacement
- `apps/api/src/services/nodes.ts` — calls `generateCloudInit()` during node provisioning (lines 150-169)
- `apps/api/src/env.ts` — Cloudflare Workers Env interface for all env vars

### Existing patterns
- Optional fields use `field?: string` in `CloudInitVariables` interface
- Validation uses regex patterns (NUMERIC_RE for ports/timeouts)
- Defaults provided via `??` in replacements object
- Template uses runcmd for sequential boot commands with `logger -t sam-boot` phases
- write_files section for persistent config files

### Swap implementation approach
- Use runcmd (not cloud-init's swap module) — consistent with existing template style
- Place swap commands BEFORE vm-agent download in runcmd section
- Use conditional `if [ "$SWAP_SIZE_MB" -gt 0 ]` to allow disabling
- Persist swappiness via `/etc/sysctl.d/99-sam-swap.conf`

## Implementation Checklist

### 1. `packages/cloud-init/src/generate.ts`
- [x] Add `swapSizeMb?: string` and `swapSwappiness?: string` to `CloudInitVariables` interface
- [x] Add validation: swapSizeMb must be numeric 0-65536, swapSwappiness must be numeric 0-100
- [x] Add template replacements with defaults: `{{ swap_size_mb }}` → 2048, `{{ swap_swappiness }}` → 60

### 2. `packages/cloud-init/src/template.ts`
- [x] Add conditional runcmd block before vm-agent download: fallocate → chmod → mkswap → swapon → sysctl
- [x] Wrap in `if [ "{{ swap_size_mb }}" -gt 0 ]` conditional
- [x] Add `logger -t sam-boot` phase markers
- [x] Add write_files entry for `/etc/sysctl.d/99-sam-swap.conf` for persistent swappiness

### 3. `packages/cloud-init/tests/generate.test.ts`
- [x] Test default swap values (2048 MB, swappiness 60)
- [x] Test custom swap values
- [x] Test swap disabled via "0"
- [x] Test sysctl persistence file generated
- [x] Test swap commands ordered before vm-agent download
- [x] Test validation rejects non-numeric swapSizeMb
- [x] Test validation rejects out-of-range swapSwappiness (>100)
- [x] Test validation rejects shell metacharacters

### 4. `apps/api/src/env.ts`
- [x] Add `SWAP_SIZE_MB?: string` to Env interface
- [x] Add `SWAP_SWAPPINESS?: string` to Env interface

### 5. `apps/api/src/services/nodes.ts`
- [x] Pass `swapSizeMb: env.SWAP_SIZE_MB` to generateCloudInit()
- [x] Pass `swapSwappiness: env.SWAP_SWAPPINESS` to generateCloudInit()

### 6. `apps/api/.env.example`
- [x] Document `SWAP_SIZE_MB` with description and default
- [x] Document `SWAP_SWAPPINESS` with description and default

### 7. `scripts/vm/cloud-init.yaml`
- [x] Update reference template to match production output
- [x] Ensure NO HETZNER_TOKEN present

## Acceptance Criteria

- [ ] Swap file is created on VM boot with configurable size (default 2048 MB) — requires infrastructure verification
- [x] Swappiness is configurable (default 60) and persists across reboots via sysctl.d
- [x] Setting swap size to "0" disables swap entirely (no fallocate, no swapon)
- [x] All values validated with strict numeric checks — no shell injection possible
- [x] No HETZNER_TOKEN or provider credentials on VMs
- [x] All existing tests pass
- [x] New tests cover defaults, custom values, disabled, validation, ordering
- [x] Reference template updated to match production

## References

- PR #1118 review (session aaf17856-cd01-46bc-82e2-cd795088edb3)
- `.claude/rules/03-constitution.md` — Principle XI (no hardcoded values)
- `docs/architecture/credential-security.md` — BYOC model
