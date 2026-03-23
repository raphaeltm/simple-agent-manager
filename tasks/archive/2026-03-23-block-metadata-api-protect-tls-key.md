# Block Cloud Metadata API Access & Protect TLS Key

## Problem

Two container isolation gaps on provisioned VMs:

1. **Metadata API exposure**: Any Docker container on the VM can reach the cloud provider metadata API at `169.254.169.254`, which contains the cloud-init user-data — including the TLS private key.
2. **TLS key defense-in-depth**: While `write_files` sets `permissions: '0600'` on the key file, there's no explicit `chmod`/`chown` enforcement in runcmd as a fallback.

## Research Findings

- **Firewall script** (`template.ts` lines 121-215): Manages INPUT chain only. Does not touch FORWARD chain or DOCKER-USER chain.
- **DOCKER-USER chain**: Docker's designated chain for user firewall rules in the FORWARD path. Container egress to external IPs traverses this chain. Inserting a DROP rule for `169.254.169.254` blocks containers from reaching the metadata API while host-level access is unaffected.
- **TLS key file** (`template.ts` line 229-232): Already has `permissions: '0600'` via cloud-init `write_files`. Owner defaults to `root:root`.
- **Daily cron refresh** (`template.ts` lines 217-222): Runs the firewall script daily. The metadata blocking rule must be idempotent to handle repeated execution.
- **iptables-save** (`template.ts` lines 211-213): Persists all chains including DOCKER-USER, so the metadata rule will survive reboots.

## Implementation Checklist

- [ ] Add metadata API blocking section to firewall setup script in `template.ts`:
  - `iptables -D DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || true` (idempotent removal)
  - `iptables -I DOCKER-USER 1 -d 169.254.169.254 -j DROP` (insert at top)
  - Same for ip6tables (defense-in-depth, even though metadata API is IPv4-only)
  - Place after Docker bridge allowance section, before iptables-save
- [ ] Add explicit TLS key permission hardening in runcmd:
  - `chmod 600 /etc/sam/tls/origin-ca-key.pem` (defense-in-depth)
  - `chown root:root /etc/sam/tls/origin-ca-key.pem`
  - Only when TLS is configured (conditional on key file existence)
- [ ] Add tests for metadata API blocking:
  - Firewall script contains DOCKER-USER metadata drop rule
  - Rule is idempotent (delete-then-insert pattern)
  - Both IPv4 and IPv6 DOCKER-USER rules present
  - Rules appear before iptables-save (so they're persisted)
- [ ] Add tests for TLS key permission hardening:
  - runcmd includes chmod/chown for the key file when TLS is configured
  - runcmd does NOT include chmod/chown when TLS is not configured
- [ ] Verify YAML validity and 32KB size limit with new content

## Acceptance Criteria

- [ ] Generated cloud-init blocks container access to `169.254.169.254` via DOCKER-USER iptables chain
- [ ] TLS private key file has explicit permission hardening in runcmd when TLS is enabled
- [ ] All existing tests continue to pass (no regressions)
- [ ] New tests verify metadata blocking and TLS key hardening
- [ ] Generated YAML remains valid and within 32KB limit
- [ ] No hardcoded values that should be configurable (constitution Principle XI)

## References

- `packages/cloud-init/src/template.ts` — cloud-init template
- `packages/cloud-init/src/generate.ts` — template rendering
- `packages/cloud-init/tests/generate.test.ts` — existing tests
