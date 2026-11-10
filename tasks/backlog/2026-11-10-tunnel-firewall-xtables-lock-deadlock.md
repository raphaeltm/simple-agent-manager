# Tunnel firewall script can deadlock on the xtables lock under iptables-legacy

## Problem

`TUNNEL_FIREWALL_WRITE_FILE` (packages/cloud-init/src/template-ingress.ts, from #2615, reused unchanged by the
reverse-tunnel transport) runs `rules iptables | iptables-restore --noflush`. The producer function `rules()` calls
`iptables -C INPUT -j SAM-TUNNEL-INGRESS` while `iptables-restore` (the consumer) already holds the global
xtables lock (`/run/xtables.lock`, shared across network namespaces). Under iptables-legacy (v1.8.9) the `-C` waits
for the lock and `iptables-restore` waits for stdin: a deadlock.

## Context

Found 2026-11-10 while running `packages/cloud-init/tests/tunnel.test.ts` ("tunnel firewall against real netfilter")
in a devcontainer with iptables-legacy and passwordless sudo: the test timed out after 60 s and left
`iptables-restore --noflush` + `iptables -C ...` running as root, which then blocked Docker's own bridge iptables
calls (`docker run` hung at "Created") until the processes were killed. Ubuntu VM images use iptables-nft, which is
presumably why staging VMs did not hit it, but a legacy-iptables image would hang the vm-agent's ExecStartPre.

## Acceptance Criteria

- [ ] Compute the `-C` check before starting `iptables-restore` (or pass `-w` and order the calls so no producer
      needs the lock the consumer holds).
- [ ] The real-netfilter test passes under iptables-legacy and never leaves processes behind on timeout.
- [ ] Verify on an nft image as well.
