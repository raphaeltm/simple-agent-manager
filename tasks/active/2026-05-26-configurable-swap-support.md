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
- [ ] Add `swapSizeMb?: string` and `swapSwappiness?: string` to `CloudInitVariables` interface
- [ ] Add validation: swapSizeMb must be numeric 0-65536, swapSwappiness must be numeric 0-100
- [ ] Add template replacements with defaults: `{{ swap_size_mb }}` → 2048, `{{ swap_swappiness }}` → 60

### 2. `packages/cloud-init/src/template.ts`
- [ ] Add conditional runcmd block before vm-agent download: fallocate → chmod → mkswap → swapon → sysctl
- [ ] Wrap in `if [ "{{ swap_size_mb }}" -gt 0 ]` conditional
- [ ] Add `logger -t sam-boot` phase markers
- [ ] Add write_files entry for `/etc/sysctl.d/99-sam-swap.conf` for persistent swappiness

### 3. `packages/cloud-init/tests/generate.test.ts`
- [ ] Test default swap values (2048 MB, swappiness 60)
- [ ] Test custom swap values
- [ ] Test swap disabled via "0"
- [ ] Test sysctl persistence file generated
- [ ] Test swap commands ordered before vm-agent download
- [ ] Test validation rejects non-numeric swapSizeMb
- [ ] Test validation rejects out-of-range swapSwappiness (>100)
- [ ] Test validation rejects shell metacharacters

### 4. `apps/api/src/env.ts`
- [ ] Add `SWAP_SIZE_MB?: string` to Env interface
- [ ] Add `SWAP_SWAPPINESS?: string` to Env interface

### 5. `apps/api/src/services/nodes.ts`
- [ ] Pass `swapSizeMb: env.SWAP_SIZE_MB` to generateCloudInit()
- [ ] Pass `swapSwappiness: env.SWAP_SWAPPINESS` to generateCloudInit()

### 6. `apps/api/.env.example`
- [ ] Document `SWAP_SIZE_MB` with description and default
- [ ] Document `SWAP_SWAPPINESS` with description and default

### 7. `scripts/vm/cloud-init.yaml`
- [ ] Update reference template to match production output
- [ ] Ensure NO HETZNER_TOKEN present

## Acceptance Criteria

- [ ] Swap file is created on VM boot with configurable size (default 2048 MB)
- [ ] Swappiness is configurable (default 60) and persists across reboots via sysctl.d
- [ ] Setting swap size to "0" disables swap entirely (no fallocate, no swapon)
- [ ] All values validated with strict numeric checks — no shell injection possible
- [ ] No HETZNER_TOKEN or provider credentials on VMs
- [ ] All existing tests pass
- [ ] New tests cover defaults, custom values, disabled, validation, ordering
- [ ] Reference template updated to match production

## References

- PR #1118 review (session aaf17856-cd01-46bc-82e2-cd795088edb3)
- `.claude/rules/03-constitution.md` — Principle XI (no hardcoded values)
- `docs/architecture/credential-security.md` — BYOC model
