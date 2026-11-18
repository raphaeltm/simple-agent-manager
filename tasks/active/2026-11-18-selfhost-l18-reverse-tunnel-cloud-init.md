# L18: reverse-tunnel cloud-init (frpc connector) on main

## Problem

L17a (#2831) and L17b (#2859, b7502ba96) landed reverse-tunnel leases, frps authorization, routing
and the self-host gateway under `apps/api/src/selfhost/reverse-tunnel/`. The transport driver
(`installReverseTunnelTransport(render)` in `selfhost/reverse-tunnel/transport.ts`) passes
`reverseTunnelCredential`, `reverseTunnelRemotePort` and `reverseTunnelLocalPort` to its boot
renderer, but main's `@simple-agent-manager/cloud-init` ignores them: a reverse-tunnel node would
boot as a direct-ingress node with no frpc, so it could never be reached. L18 adds the
reverse-tunnel ingress mode to the cloud-init package.

SAM task 01M7QB46M5C4GE1Z51D1ZNEBGJ; coordinator 01M7JMXS2JRW6QQMB1356ENPM3; plan idea
01M72M9AEB933ZY8269D376DKC (LANDING PLAN part 6, row L18). Source `origin/sam/selfhost-pass-2`
(tip 942d2c0a4), ported with `git checkout <ref> -- <paths>`, no cherry-picks.

## Research findings

- The integration branch's cloud-init diff against main is exactly the L18 file list:
  `reverse-tunnel.ts` (new), `template-reverse-tunnel.ts` (new), `tunnel.ts`, `template-ingress.ts`,
  `variables.ts`, `index.ts`, plus `tests/reverse-tunnel.test.ts`. generate.ts / validate.ts /
  template.ts are unchanged, so the mode plugs into main's existing `ingressFragments()` and
  `tunnelReplacements()` seams.
- Seam on main: the reverse-tunnel driver is installed only by `withReverseTunnel(worker, render)`
  (`selfhost/reverse-tunnel/entry.ts`), which nothing in the Cloudflare Worker imports. The
  Cloudflare provisioning path (`buildNodeCloudInit`, `node-provisioning-cloud-init.ts`) never sets
  the reverse-tunnel variables, so Cloudflare nodes take the existing branches.
- Cross-boundary contract: the frpc install block reports `sam-boot-failure frpc_install` to
  `POST /api/nodes/:id/boot-failure`. Main's picklist (`routes/node-boot-failure.ts`) rejects that
  reason with 400, so a failed frpc install would go unrecorded. The integration branch adds
  `frpc_install`; include it with its route test (rule 23). Only reverse-tunnel nodes send it.
- Template refactor in `template-ingress.ts`: the listener wait script is split out as
  `TUNNEL_LISTENER_WAIT_WRITE_FILE` and `TUNNEL_WRITE_FILES` re-composes it. Must be byte-identical
  for Cloudflare Tunnel nodes: proven by file snapshots recorded on main before the change.
- frpc config keeps the credential out of the world-readable frpc.toml (frp `{{ .Envs.* }}`
  template, root-only 0400 EnvironmentFile). The frpc release is pinned with sha256 per arch.
- No open PR touches these paths (checked `gh pr list`, 2026-11-18).

## Checklist

- [x] Record Cloudflare output snapshots (direct Origin CA default, task, deployment, minimal,
      Cloudflare Tunnel defaults, task, deployment and configured) from main's cloud-init src
- [x] Bring the L18 cloud-init files from `origin/sam/selfhost-pass-2`; confirm byte-identity
      (`git diff origin/sam/selfhost-pass-2 -- <paths>` empty)
- [x] Add `frpc_install` to the boot-failure picklist + route test
- [x] Snapshot test passes unchanged after the change (byte-identical Cloudflare output)
- [x] Reverse-tunnel tests (render, validation, executed runcmd under /bin/sh) pass
- [x] API reverse-tunnel tests that render through `installReverseTunnelTransport(generateCloudInit)`
      pass against the new renderer
- [x] Docs: self-hosting.mdx (boot mode), security.md (reverse-tunnel ingress; `isTunnelMode` now covers both tunnel modes), packages/cloud-init/AGENTS.md, rule 06 cloud-init step
- [ ] lint, typecheck, test, build
- [x] security-auditor (PASS: 0 CRITICAL/HIGH/MEDIUM; 3 LOW deferred to tasks/backlog/2026-11-18-reverse-tunnel-cloud-init-hardening.md to keep byte-identity with the BOX-proven tip), task-completion-validator (WARN, no CRITICAL/HIGH; all four items addressed in a0bb64b27)
- [ ] BOX proof (byte-identical to integration tip: cite BOX run 01M7QB382PDGH42XEG3ZFFS6DE)
- [ ] Staging: real VM node provisioning with heartbeat, then cleanup

## Acceptance criteria

- A Cloudflare node (direct or Cloudflare Tunnel) renders byte-identical cloud-init to main
  (file snapshot test).
- A reverse-tunnel node renders the frpc connector, the tunnel firewall, no Origin CA and no
  cloudflared; the credential appears only in the 0400 credential file.
- Invalid reverse-tunnel variable combinations are rejected without echoing the credential.
- The control plane accepts `frpc_install` boot-failure reports.
- Staging node provisioning still boots a VM that heartbeats; VM cleaned up.
