# Cloudflare Tunnel staging proof

User authorized proceeding with the staging proof without the blocked Fable
review. Canonical design/research: SAM BYO idea `01KY7M8N1RBC4ZV6ZKSNG878B3`.

- [x] Verify updated staging token by creating a named tunnel.
- [x] Measure same-zone Worker fetch through real DNS at 443 and 8443.
- [x] Check edge TLS for existing nested VM hostname and flat alternative.
- [x] Verify WebSocket idle/binary, streaming, and two HTTP ports through one tunnel.
- [x] Verify fixture auth and connector stop/restart, without public origin listeners.
- [x] Delete owned DNS/routes/Worker/tunnel and retain sanitized evidence.
- [x] Exercise actual VM-agent auth/preview/Git handlers with isolated synthetic dependencies.
- [x] Record integration findings and the next smallest real-node slice.

Scope: first resolve the named-tunnel feasibility gate with an isolated CI
origin in staging. This is not evidence that managed-node integration has shipped.
No production changes or real-user workloads.

Research findings to resolve before a real-node cutover:

- A tunnel reaching the existing VM agent on localhost may pass the Git
  credential endpoint's local-source check. Preserve the private Docker helper
  path while treating tunnel ingress as external; do not expose an unauthenticated
  localhost credential exchange.
- Centralize transport URL choice; multiple existing callers append port 8443.
- Preserve the existing greedy `.vm` Worker route exclusion; test edge TLS.
- Provision/deletion must journal tunnel identity before VM creation and fence
  cleanup by runtime incarnation. Cleanup must include failed provisioning.
- Installer permissions must work for both clean installs and upgrades.

These belong to the canonical BYO integration idea above; this experiment does
not implement or claim them complete.

First run: https://github.com/raphaeltm/simple-agent-manager/actions/runs/42774732470
at `1c084a124`. All transport assertions pass. Both nested and flat hostname
Worker fetches work at 443 and 8443. Direct nested hostname TLS fails; direct flat
TLS passes. Direct tunnel requests arrive on loopback with neither existing relay
header. Dedicated externally-classified listener passed in run
https://github.com/raphaeltm/simple-agent-manager/actions/runs/42775358378 at `e5b416dfa`.
Real preview JWT validation, wrong/missing/expired tokens, two ports, preview
WebSocket, token stripping, public Git rejection, private helper success, and
preview-to-private-helper rejection all passed. See
`experiments/cloudflare-tunnel/FINDINGS.md` for the exact evidence and remaining
managed-node integration. No production feature or managed-node rollout claimed.

## Authorized next phase: implementation and full staging E2E

User requested the complete managed-VM tunnel implementation and thorough live
staging validation, covering all VM-agent communication and port forwarding,
while retaining instant-container compatibility. Plan requested before execution.
The earlier synthetic proof does not satisfy this phase.

- [x] Inventory every browser/API/CLI/MCP-to-agent path and callback; maintain an
      endpoint-to-test matrix with live evidence or explicit failure-path coverage.
- [x] Centralize transport selection for tunnel VMs, legacy VMs, and instant
      containers. Preserve container DO forwarding, timeout and cold-wake/no-wake
      semantics; containers must never acquire tunnel resources.
- [x] Provision one named tunnel per VM incarnation with journaled identity,
      CNAME, connector bootstrap, readiness and credential protection. Node receives
      only its tunnel credential; account API token stays in control plane.
- [x] Implement dedicated externally-classified ingress; preserve private Docker
      Git helper access; block public inbound IPv4/IPv6 before serving requests.
- [x] Cover all URL callers: readiness, management, terminal/ACP/boot-log streams,
      previews, local forwarding, files/attachments/snapshots, Git/worktrees, MCP
      tools/secret execution/build-publication and diagnostics/teardown callers.
- [ ] Handle failed provisioning, cancellation, retries, connector restart,
      credential revocation, stale-incarnation cleanup and eventual deletion retries.
- [x] Wire installation settings, permissions, upgrade/clean-install support and
      docs. Preserve existing direct-IP nodes; no IP fallback for tunnel nodes.
- [ ] Deploy pinned staging build; actual agent creates/runs site on port3000
      through normal authenticated UI, inside a real managed devcontainer.
- [ ] Browser test assets, routes, queries, POST, redirects, auth/cookies,
      public/private previews, HMR/WebSockets and closing/reopening exposure.
- [ ] Test second workspace using the same port on the same VM; test supported
      CLI local forwarding and cross-user authorization with separate identities.
- [ ] Exercise agent prompt/stream/steer/cancel, terminal input/resize/reconnect,
      workspace create/rebuild/stop/restart/delete, session sleep/wake/snapshot restore,
      file upload/download, Git/credential refresh, MCP operations and diagnostics.
- [ ] Prove origin-IP independence with firewall/listener evidence, tunnel-only
      DNS, explicit transport assertions and route logs. Stop tunnel: access fails
      with no IP fallback; restart: recovery succeeds. Browser traces alone do not
      establish the Worker-to-origin path.
- [ ] Negative security tests: missing/invalid/expired/wrong-scope tokens, direct
      tunnel credential/management access, preview-to-helper relay, reserved ports,
      and absence of credentials in target apps or evidence logs.
- [ ] Run applicable live user flows on actual instant containers: startup,
      agent interaction, port3000 previews/WS, terminal, files/Git and sleep/wake/
      cleanup. Verify no tunnel creation and correct routing in mixed deployments.
- [ ] Review Go/security/Cloudflare/env/docs changes; resolve blocking findings.
- [ ] Retain reproducible tests, screenshots/traces, exact candidate SHA and
      task/session IDs, network-path evidence, and per-scenario results.
- [ ] Delete test VMs/containers/DNS/tunnels and verify remote inventory.

Bound tests to one VM normally, a second only for required isolation/replacement,
and one explicit instant-container fixture. Estimate spend before extended fault
testing. Deliver staging implementation and evidence; production tunnel cutover
is outside this phase. General-purpose raw public TCP/UDP exposure is not part
of the existing HTTP/WebSocket forwarding contract.

## Implementation checkpoint (2026-11-10)

Integrated dedicated Go tunnel ingress, cloud-init connector/firewall, API tunnel
creation and durable cleanup, caller URL consolidation, installer OAuth permission
upgrade and eight typed admin settings. The parent review additionally required
resume safety, transport-switch metadata and delayed external-create reconciliation;
those fixes have focused regression coverage and are in final integration review.

Root lint/typecheck/build pass. The full web test run passed its assertions but
failed on an unrelated toast teardown timer; isolated file rerun passes and SAM idea
`01M729EEJXM1W9QBKFC9QJEVRN` tracks it. This is not a clean root test-suite pass.

Staging fixture project and both profiles exist; no test compute has been started.
The staging-only transport variable is set for the upcoming deployment. Live
scenario results belong in `experiments/cloudflare-tunnel/STAGING-E2E.md`.
Admin settings passed read-only mocked desktop/mobile visual validation; deployed
definitions still require the final live rerun.

## Live sweep checkpoint (09:47 UTC)

The initial managed staging deployment is green and both real VM/instant agents ran the port3000 fixture. See the staging matrix for exact IDs and passed surfaces. Full API15,719 tests /1067 files, CI root Test, SonarCloud, secret scan and Durable Object Workers pass on8a3321ad5. Admin controls have reviewed desktop/mobile evidence posted on PR2615.

Live testing found preview credential leakage, redirect auto-follow and an existing instant PTY spawn conflict. These are fixed with targeted regression coverage and independent review before the final staging candidate. Remaining lifecycle/fault/cleanup gates are open; this task is not complete.
