# Reverse-tunnel cloud-init hardening (L18 security review LOWs)

## Problem

The security review of L18 (PR #2885, reverse-tunnel cloud-init) found no CRITICAL, HIGH or
MEDIUM issues and three LOW ones. They were deferred so the L18 files stay byte-identical to the
integration branch `sam/selfhost-pass-2`, whose live BOX run is the L18 box evidence. Land them on
the integration branch first (so the next BOX run covers them), then on main with the slice that
next touches `packages/cloud-init/src/reverse-tunnel.ts`.

## Context

- Found by the security-auditor reviewer on PR #2885, 2026-11-18.
- Landing plan: idea 01M72M9AEB933ZY8269D376DKC.

## Findings

1. `reverseTunnelServerAddress` (`packages/cloud-init/src/reverse-tunnel.ts`) renders
   `serverAddr = ""` when `new URL(controlPlaneUrl)` throws (for example a port above 65535 that
   passes `SAFE_URL_RE`). frpc then dials `0.0.0.0` and fails TLS before sending the credential,
   so the node boots but never connects. The comment claims validation already rejected it; it
   does not. Provisioning always passes `https://api.${BASE_DOMAIN}`, so this is unreachable
   today.
2. `reverseTunnelRemotePort` accepts 1-65535. The value comes from the lease allocator; the real
   enforcement is the box's frps (`allowPorts` = lease range, `proxyBindAddr = 127.0.0.1`) and
   the authorization plugin comparing `remotePort` with the lease (L22 front-door criteria).
3. Parity hardening for both connector units and downloads: `curl --proto '=https'
   --proto-redir '=https'`; `RestrictNamespaces=yes`, `ProtectProc=invisible`,
   `SystemCallArchitectures=native`, `UMask=0077`; write `credential.env` under `umask 077`.

## Acceptance Criteria

- [ ] Reverse mode rejects a control-plane URL with no parseable host or an invalid port, with a
      validation error that does not echo the credential; the misleading comment is fixed.
- [ ] Reverse mode rejects remote ports below 1024 (or outside a configured lease range).
- [ ] Box frps config confirmed: `allowPorts` equals the lease range, `proxyBindAddr = 127.0.0.1`,
      plugin checks `remotePort` against the lease on NewProxy.
- [ ] Download and unit hardening applied to both cloudflared and frpc, with the Cloudflare
      snapshot change reviewed deliberately (it changes Cloudflare output).
