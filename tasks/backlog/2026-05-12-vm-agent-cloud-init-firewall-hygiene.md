# VM Agent Cloud-Init & Firewall Hygiene

## Problem

Debug package analysis revealed several cloud-init and firewall hygiene issues that affect VM agent runtime stability:

1. **apt-daily timers kill vm-agent** — Ubuntu's `apt-daily.timer` and `apt-daily-upgrade.timer` trigger `unattended-upgrades` which can cause a systemd daemon-reexec, restarting/killing the vm-agent mid-work. VMs are ephemeral; auto-upgrades provide zero benefit and destroy active workloads.

2. **IPv6 firewall rules fail to load** — Debug package showed `Error: IPv6 rules failed test load. New rules NOT loaded`. IPv4 rules correctly restrict port 8443 to Cloudflare CIDRs, but IPv6 may leave the agent port exposed directly.

3. **Cloud-init deprecation warnings** — Potential deprecation warnings from cloud-init schema (nonfatal now but may break with future versions).

## Research Findings

### Fix 1: apt-daily timers
- Cloud-init already sets `package_update: false` / `package_upgrade: false` in `packages/cloud-init/src/template.ts:16-17`
- But `apt-daily.timer`, `apt-daily-upgrade.timer`, and `unattended-upgrades` are independent systemd timers on Ubuntu
- Must be disabled in cloud-init `runcmd` BEFORE vm-agent starts so they cannot race
- Three commands: `systemctl disable --now apt-daily.timer apt-daily-upgrade.timer` and `systemctl disable --now unattended-upgrades`

### Fix 2: IPv6 firewall
- The firewall script in template.ts:184-198 already has `ip6tables` commands mirroring IPv4
- The `iptables-persistent` package installation in `provision.go:357-361` should provide ip6tables
- But the ip6tables kernel module (`ip6_tables`) may not be loaded by default on some Hetzner images
- The firewall script uses `ip6tables` directly — if the module isn't loaded, all ip6tables commands fail
- Fix: Add `modprobe ip6_tables` before ip6tables commands in the firewall script, with a fallback to skip IPv6 rules if the module can't be loaded (some kernels may not have it)

### Fix 3: Cloud-init template
- Current template uses `users:` with `- name: workspace` — correct modern syntax
- No `chpasswd` section exists in our template
- No deprecated `lists` syntax in our template
- The `ssh_authorized_keys: []` empty array is valid
- The deprecation warnings may come from Ubuntu's default cloud-init config, not our template
- No changes needed for template syntax — already using modern format

### Message reporter at early boot
- `packages/vm-agent/internal/server/late_init_reporter_test.go` shows the reporter is lazily initialized
- The message reporter requires workspace context (projectId, chatSessionId) which is set when the first workspace is created
- At boot time, no workspace exists yet — this is expected behavior, not a bug
- Provisioning errors are already captured in the eventstore (see `provision.go:142-161`) and accessible via debug package
- No changes needed

## Implementation Checklist

### 1. Disable apt-daily timers in cloud-init runcmd
- [ ] Add runcmd commands to disable apt-daily.timer, apt-daily-upgrade.timer, unattended-upgrades BEFORE vm-agent start
- [ ] Add test verifying the generated cloud-init output contains the disable commands

### 2. Fix IPv6 firewall reliability
- [ ] Add `modprobe ip6_tables` and graceful fallback to firewall script in template.ts
- [ ] Add test verifying ip6tables module loading is in the firewall script

### 3. Cloud-init and firewall tests
- [ ] Add test verifying apt timer disable commands are in runcmd and ordered before vm-agent start
- [ ] Add test verifying firewall script handles IPv6 module loading
- [ ] Verify all existing tests pass

## Acceptance Criteria

- [ ] Cloud-init disables apt-daily.timer, apt-daily-upgrade.timer, and unattended-upgrades before vm-agent starts
- [ ] Firewall script loads ip6_tables kernel module before ip6tables commands
- [ ] Firewall script gracefully handles systems where IPv6 kernel module is unavailable
- [ ] All existing tests pass
- [ ] New tests verify the added cloud-init commands and firewall changes

## References

- Debug package analysis from task 01KRDNFM8A70P6EXYEJJPZ3VSQ
- `packages/cloud-init/src/template.ts` — cloud-init template
- `packages/cloud-init/tests/generate.test.ts` — existing tests
- `packages/vm-agent/internal/provision/provision.go` — vm-agent provisioning
- `tasks/backlog/2026-05-12-fix-vm-agent-stability.md` — broader task (this is a subset)
