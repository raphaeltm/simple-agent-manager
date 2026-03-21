# Add OS-Level Firewall to VM Cloud-Init

## Problem Statement

SAM VMs currently have no OS-level firewall. Security relies on Cloudflare edge proxying, TLS (Origin CA), JWT auth, and application-layer isolation. If someone discovers the VM's public IP, they can reach ports 8080/8443 directly, bypassing Cloudflare. Adding iptables rules via cloud-init provides defense-in-depth at the network layer.

## Research Findings

### Firewall Approach: iptables (not ufw)
- **ufw** has interactive prompts that can fail in cloud-init; requires workarounds
- **iptables** works directly and reliably in cloud-init runcmd; no extra packages needed for rules
- **iptables-persistent** saves rules across reboots (needed since cloud-init only runs on first boot)
- Docker manipulates FORWARD/NAT chains; our rules only touch INPUT chain — no conflict

### Key Files
- `packages/cloud-init/src/template.ts` — cloud-init YAML template (write_files + runcmd)
- `packages/cloud-init/src/generate.ts` — variable substitution, CloudInitVariables interface
- `packages/cloud-init/tests/generate.test.ts` — existing test patterns (YAML parsing)
- `packages/vm-agent/internal/config/config.go` — VM agent port config (default 8443 with TLS, 8080 without)
- `docs/architecture/walkthrough.md` — architecture docs to update

### Docker Networking Considerations
- Docker uses FORWARD chain and NAT table for container networking — not affected by INPUT rules
- Containers communicate with the host VM agent via docker0 bridge — must allow docker0/br-* interface traffic
- Default OUTPUT policy stays ACCEPT — outbound traffic (package installs, API callbacks, heartbeats) unaffected

### Cloudflare IP Ranges
- Published at https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
- Strategy: fetch dynamically at boot time, fall back to embedded defaults, refresh daily via cron
- Current IPv4 ranges (13 CIDRs) and IPv6 ranges (7 CIDRs) embedded as fallback

### 32KB Size Limit
- Current template with TLS certs is well within 32KB
- Firewall script adds ~2-3KB — still within limit

## Implementation Checklist

- [ ] Add firewall setup script as write_files entry in template.ts
  - Fetch Cloudflare IPv4/IPv6 ranges from published endpoints
  - Fall back to embedded defaults if fetch fails
  - Configure iptables INPUT chain: allow loopback, established/related, docker bridge, CF IPs on agent port, drop rest
  - Configure ip6tables similarly
  - Save rules for persistence
- [ ] Add daily cron job script as write_files entry for Cloudflare IP refresh
- [ ] Add runcmd entries to:
  - Preseed iptables-persistent to avoid interactive prompts
  - Install iptables-persistent
  - Run firewall setup script
- [ ] Update tests in generate.test.ts:
  - Verify firewall script is present in write_files with correct permissions
  - Verify cron job is present
  - Verify runcmd includes firewall setup
  - Parse YAML output and verify firewall script contains port placeholder substitution
  - Verify 32KB limit still passes
- [ ] Update docs/architecture/walkthrough.md to document the firewall layer
- [ ] Verify all {{ }} placeholders are still fully substituted (existing regression test)

## Acceptance Criteria

- [ ] Generated cloud-init includes iptables firewall script allowing only Cloudflare IPs on VM agent port
- [ ] Firewall allows loopback, established connections, and Docker bridge traffic
- [ ] SSH (port 22) is explicitly blocked (default DROP policy)
- [ ] Daily cron job refreshes Cloudflare IP ranges
- [ ] All existing tests pass (no regressions)
- [ ] New tests verify firewall configuration in generated YAML
- [ ] Config stays within 32KB Hetzner user-data limit
- [ ] Architecture docs updated to reflect firewall layer
- [ ] VM boots successfully with firewall enabled (staging verification)
- [ ] VM agent heartbeats arrive at control plane through firewall
- [ ] Workspace accessible via ws-* subdomain through Cloudflare

## References

- Cloudflare IP ranges: https://www.cloudflare.com/ips/
- Task requirement: defense-in-depth, network-layer isolation
- Related: docs/architecture/credential-security.md
