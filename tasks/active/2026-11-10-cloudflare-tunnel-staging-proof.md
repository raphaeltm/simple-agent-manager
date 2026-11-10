# Cloudflare Tunnel staging proof

User authorized proceeding with the staging proof without the blocked Fable
review. Canonical design/research: SAM BYO idea `01KY7M8N1RBC4ZV6ZKSNG878B3`.

- [ ] Verify updated staging token by creating a named tunnel.
- [ ] Measure same-zone Worker fetch through real DNS at 443 and 8443.
- [ ] Check edge TLS for existing nested VM hostname and flat alternative.
- [ ] Verify WebSocket idle/binary, streaming, and two HTTP ports through one tunnel.
- [ ] Verify fixture auth and connector stop/restart, without public origin listeners.
- [ ] Delete owned DNS/routes/Worker/tunnel and retain sanitized evidence.
- [ ] Record integration findings and the next smallest real-node slice.

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
