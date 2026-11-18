# Reverse-tunnel cloud-init hardening (L18 security review LOWs)

## Problem

The security review of L18 (PR #2885, reverse-tunnel cloud-init) found no CRITICAL, HIGH or
MEDIUM issues and three LOW ones. Finding 1 was then fixed in PR #2885 after CodeRabbit raised it too. The others were deferred so the L18 files stay close to the
integration branch `sam/selfhost-pass-2`, whose live BOX run is the L18 box evidence. Land them on
the integration branch first (so the next BOX run covers them), then on main with the slice that
next touches `packages/cloud-init/src/reverse-tunnel.ts`.

## Context

- Found by the security-auditor reviewer on PR #2885, 2026-11-18.
- Landing plan: idea 01M72M9AEB933ZY8269D376DKC.

## Findings

1. (Fixed in PR #2885.) `reverseTunnelServerAddress` rendered `serverAddr = ""` when
   `new URL(controlPlaneUrl)` threw (for example port 70000, which passes `SAFE_URL_RE`), and
   cloud-init validation did not reject it. Provisioning builds the URL from `BASE_DOMAIN`
   without checking it; only the installer's domain pattern (which rejects a port) kept
   installer-deployed control planes from producing such a value. Reverse mode now rejects it at
   the renderer.
2. `reverseTunnelRemotePort` accepts 1-65535. The value comes from the lease allocator; the real
   enforcement is the box's frps (`allowPorts` = lease range, `proxyBindAddr = 127.0.0.1`) and
   the authorization plugin comparing `remotePort` with the lease (L22 front-door criteria).
3. Parity hardening for both connector units and downloads: `curl --proto '=https'
   --proto-redir '=https'`; `RestrictNamespaces=yes`, `ProtectProc=invisible`,
   `SystemCallArchitectures=native`, `UMask=0077`; write `credential.env` under `umask 077`.
4. Boot secrets are written by cloud-init `write_files`, which opens the file under the process
   umask, writes, then chmods (CodeRabbit on #2885). This applies to the reverse-tunnel
   `credential.env` (0400) and equally to `/etc/sam/callback-token` (0600) on every Cloudflare
   node. The window is cloud-init's init stage, before SSH, devcontainers or user workloads
   exist. Fix both together, for example a root-only `/etc/sam` created in `bootcmd` (which
   runs before `write_files`), and review the Cloudflare snapshot change deliberately.
5. Cloudflare mode passes tunnel numbers through verbatim, so a leading zero
   (`VM_AGENT_TUNNEL_LISTENER_WAIT_SECONDS=08`) would break dash arithmetic in the listener wait
   script. Reverse mode renders canonical decimal since #2885; Cloudflare output was left
   byte-identical in L18.

## Acceptance Criteria

- [x] Reverse mode rejects a control-plane URL with no parseable host or an invalid port (fixed in
      PR #2885 after CodeRabbit raised it too; port to `sam/selfhost-pass-2`).
- [ ] Reverse mode rejects remote ports below 1024 (or outside a configured lease range).
- [ ] Box frps config confirmed: `allowPorts` equals the lease range, `proxyBindAddr = 127.0.0.1`,
      plugin checks `remotePort` against the lease on NewProxy.
- [ ] Download and unit hardening applied to both cloudflared and frpc, with the Cloudflare
      snapshot change reviewed deliberately (it changes Cloudflare output).
- [ ] Boot secrets (`credential.env`, `callback-token`) are never readable by non-root, even
      transiently (finding 4).
- [ ] Cloudflare mode renders tunnel numbers in canonical decimal (finding 5), with the snapshot
      change reviewed.
- [ ] cloudflared parity with PR #2885's frpc fix: `TUNNEL_BOOTSTRAP_RUNCMD` ignores the exit status
      of `install -m 0755 ... /usr/local/bin/cloudflared`, so a failed install boots without a
      connector and never reports `cloudflared_install`. Left unchanged in L18 because L18 must
      not change Cloudflare output.
