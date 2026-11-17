# L17b: reverse tunnel routing, WebSocket gateway, self-host gateway route and lease sweep

## Problem

L17a (#2831, e5c5aa4f7) landed leases, frps authorization and provisioning under
`apps/api/src/selfhost/`. Main still cannot reach a reverse-tunnel node: the control plane only
knows the public `{node}.vm.{domain}` hostname, the frps plugin and Caddy forward_auth endpoints do
not exist, and the backstop sweep is not mounted. Task 01M7MH487P2E0QKKXJ4VT4RCTE; coordinator
01M7JMXS2JRW6QQMB1356ENPM3; source `origin/sam/selfhost-pass-2` (ported by hand, no cherry-picks).

## Placement (Raphaël, 2026-11-14: self-host-only code is never loaded by the Worker)

Shared Worker seams (zero added I/O on Cloudflare, where no extension is installed):
- `services/node-transport-extension.ts`: driver gains `resolveAgentOrigin`; `provisionsExtensionTransportNodes`.
- `services/node-agent-route.ts`: route from the node row (container | extension | public); a
  tunnel-only transport with no installed driver fails closed.
- `fetchNodeAgent`, the ws-* proxy and the logs stream fold `transport` into the node read they
  already make. The liveness probe reads `transport` from its existing snapshot query.
- `services/node-websocket-gateway.ts`: WeakMap marker + decision headers; one WeakMap lookup on CF.
- Snapshot upload relay: stored transport excludes tunnel-only relays; the flag suppresses only new relay provisioning (no added Cloudflare I/O).

Self-host only (`selfhost/reverse-tunnel/`): `route.ts` lease origin, `gateway.ts` frps plugin +
node-websocket forward_auth, `entry.ts` `withReverseTunnel(worker, render)` mounting the gateway
ahead of the shared app and the lease sweep on the five-minute cron.

Per-request I/O on shared routes: unchanged for every Cloudflare transport (0 added reads).
Reverse-tunnel nodes add one indexed lease read per control-plane request.

## Findings

- F19: closed by L17a (real SQL backstop/direct delete/providerless tests). L17b adds the mounted
  sweep entry-point test.
- F20 duplicate sessions: L17a authz returns a server-chosen run_id; this slice serializes it as
  `{reject:false, unchange:false, content}` (required for frps to apply it).
- F20 revocation latency: control-plane traffic and WebSocket decisions now resolve only the active
  lease of the current incarnation, so revocation applies on the next request; frps drops the
  control session within one heartbeat timeout because a refused Ping does not refresh it.
- F20 HMAC subkey: closed by L17a (HKDF purpose subkeys). Rotation: idea 01M7KPNV3B28WPEVJRNRAM2X1D.
- F21 NULL tunnel_id backfill: closed by L17a. Broad 404 matcher: box Caddy matcher, owned by L22.
- F21 Login rate limit: deferred to the front door (Caddy `/~!frp`, L22). The plugin endpoint is
  loopback-only; a probe costs one indexed read + SHA-256 against a 256-bit HMAC credential; an
  API limiter keyed on claimed node_id is rotatable, a global one locks out real nodes. L22
  acceptance criteria (loopback frps bindPort, per-source limiter, header_up overwrites, upstream
  header stripping, log redaction, real-Caddy WebSocket forward_auth check) are recorded in idea
  01M7MK0PCF032CT45Z45HRSDEQ.
- F21 port_range_cooling_down: unchanged from L17a (fail-fast with reusable-at time); reachable only
  when the whole range is cooling. Making it retryable capacity (or a minimum range size) is
  tracked in idea 01M7MK0PCF032CT45Z45HRSDEQ.
- Gating: gateway endpoints by REVERSE_TUNNEL_GATEWAY_SECRET (404 without), sweep and routing by
  the installed driver (only the self-host entry installs it), shared seams by the stored
  `nodes.transport`; new lease admission by VM_AGENT_TRANSPORT (L17a).

## Checklist

- [x] Shared route seam + fetchNodeAgent / ws proxy / logs stream / liveness probe / relay
- [x] Shared gateway decision module
- [x] Self-host route resolver, gateway routes, entry wrapper with sweep
- [x] Tests: route seam (CF zero extra read, fail-closed, revocation), gateway serializer + auth,
      forward_auth through the real app, sweep mounted entry point, liveness probe routing,
      relay exclusion, import graph
- [x] Docs: self-hosting guide gateway/entry contract
- [x] Lint/typecheck/test/build (CI to confirm); reviews: security-auditor, cloudflare-specialist, test-engineer,
      task-completion-validator
- [x] Staging: fresh default-transport VM heartbeat, system-info, terminal and agent WebSockets,
      node log stream; self-host gateway routes absent on Cloudflare; cleanup to zero VMs
- [ ] BOX debt: integration run after M4 includes L17b, before L22 (coordinator option (c),
      channel seq 165; not a per-slice merge gate)
- [ ] PR, CI, CodeRabbit, merge, idea update

## Acceptance

- Cloudflare Worker graph excludes `selfhost/`; shared routes add no I/O on Cloudflare.
- Reverse node HTTP, liveness and WebSocket traffic route to the current lease; a released lease is refused.
- frps Login allow is serialized with unchange:false/content; other ops unchange:true.
- Lease sweep runs from the self-host entry on the sweep cron, isolated, honours the kill switch.

## Takeover validation (2026-11-17)

Task `01M7NBKDNAFCMWSP5ASE305Y1S` continues PR #2859 on its existing branch. Merged main
including safe-deploy #2841 (`0c672ddbf`); no-secret-readback, build, typecheck and lint pass.
Prior four specialist reviews remain ADDRESSED; CodeRabbit rate limit ends its wait.

Coordinator message `ea9fe982-fbca-4c19-8aa5-50f75fb0820b` approves replacing the live
tunnel-marked-node check with real Worker/D1 evidence: no authorized staging fixture path
exists. Do not mutate staging D1, obtain deploy-secret write access, or add a debug endpoint.
`cloudflare-node-transport.test.ts` drives the unwrapped Worker with stored reverse-tunnel
transport and checks system-info, log stream and workspace-proxy refusal before any fetch;
same-row public-DNS controls pass. Removing the extension-only guard makes it fail.

New Codex review findings were reproduced and fixed:

- P1: the standalone self-host gateway registers the shared Hono error handler. Tests enter
  both gateway routes with redispatch/lease-query exceptions and assert sanitized JSON;
  typed route errors retain their status. All three new cases failed before the fix.
- P2: the liveness probe always resolves the stored transport within its existing budget.
  `task-liveness-no-driver.test.ts` drives both real liveness adapters with real SQLite
  snapshots and migrated ProjectData reads; unavailable reverse-tunnel routing stays
  inconclusive and never probes public DNS. Both cases fail on the old probe while all six
  public-transport controls pass. Public transports add no D1 reads.

Delta Cloudflare/security and test/completion reviews PASS. BOX remains owed after M4; the
celld entry calls `withReverseTunnel(worker, frpcRenderer)`, and main's `node-agent-route.ts`
and `node-websocket-gateway.ts` supersede the integration copies. Merge still waits for live
staging, current-head CI, and the coordinator's production #2841 hold-lift message.

## Final staging and late review validation

Head `2bb45037e`: full CI 44190373350, E2E 44190373407, Sonar, and gated staging2
44195223179 all passed. On a fresh GCP e2-medium VM in asia-south1-b (existing pool,
no settings changes), the default cloudflare-tunnel transport had a fresh heartbeat,
system-info, terminal command output, agent WebSocket session_state, and node log entries.
Cloudflare returned 404 for GET gateway/node-websocket and POST gateway/frps-plugin.
Workspace `01M7NXH8E2MPR3DY6TS48FPPTE`, node `01M7NXH86C9ECC4TQ6K8SBZTTY`, and
project `01M7NXFW8V3B9S532GH07E16V8` were deleted with 200 then GET 404; D1 confirms
our node row is absent. Preexisting Instant resources and an unrelated destroying
Hetzner row with no provider instance ID were preserved. Normal release: 44201139702.

Two late Codex P2 findings were reproduced and addressed before merge:

- Existing public snapshot relays stay selectable after new nodes switch to reverse
  tunnels. The stored-transport SQL predicate still excludes tunnel-only nodes; new
  relay provisioning remains disabled. A real SQLite mixed-transport regression
  failed before this change and passes afterward.
- Unexpected extension route exceptions retain global sanitized 500 handling. Only
  an expected missing current lease throws a sanitized NodeAgentRouteError (503).
  The injected D1 failure regression failed before this change; real Worker/D1
  gateway/proxy tests assert generic 500 bodies for invalid ports, retaining missing
  lease 503 and valid-port controls.

Both new unit cases were RED (2 failures, 17 controls passing). Final affected unit
suites: 49/49; real Worker/D1 suites: 35/35. Typecheck, focused lint and the secret
readback guard pass. Independent Cloudflare/security and test/completion delta
reviews PASS with no findings. Final-head CI and staging disposition remain tracked
in the PR body; BOX remains the documented integration debt, not a slice merge gate.


## Completion validation and final workflow gates

Task-completion-validator independently PASS at a4aca4c3b (2026-11-17):

| Check | Verdict | Evidence |
|---|---|---|
| A Research to checklist | PASS | F19–F21 implemented, prior L17a, or named L22/rotation follow-ups |
| B Checklist to diff | PASS | Shared route/gateway, self-host entry/sweep, tests and docs present |
| C Acceptance to verification | PASS | Graph/I/O, lease/revocation, frps serialization, cron isolation/kill switch and live seams |
| D UI propagation | N/A | No UI inputs |
| E Resource selection | PASS | Public/container/reverse controls; mixed-transport relay selection |
| F Vertical slice | PASS | Real Worker/D1 routes and both real SQLite liveness adapters |

No missing implementation or unsupported checked item. The remaining unchecked PR/CI/merge/idea
item is workflow finalization, not unimplemented scope. BOX is the explicit coordinator-approved
integration deferral after M4 and before L22.

Normal release 44201139702 succeeded. At 23:45:54 staging2 had no holder and the next task had
its turn; that task was notified. Global D1 read found zero allocated VMs; our node is absent.

Coordinator event ae8a3d4e-1ef9-493e-960a-33777d05ede0 approves staging carry-over:
"live VM proof taken on 2bb45037e; a4aca4c3b carried over, Cloudflare-neutral per coordinator review".
The installed-extension branch is unreachable on Cloudflare, its relay flag is always false,
and selfhost/route.ts is outside the Worker graph. Fresh full final-head CI including Workers
remains required. Any further shared Worker behavior change voids carry-over. Production #2841
merge hold was lifted at channel seq 231; serialized merge announcement and post-merge SHA
remain required. This final archive commit changes only task documentation.
