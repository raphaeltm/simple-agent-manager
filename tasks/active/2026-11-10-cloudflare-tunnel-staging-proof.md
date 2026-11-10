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
