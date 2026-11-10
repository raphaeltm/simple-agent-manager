# Named Cloudflare Tunnel staging proof

Branch-only experiment, dispatched using the `tunnel_proof_only` input on the
existing Deploy Staging workflow. It skips application deployment and uses one
GitHub runner as the outbound-only machine. Origin and preview servers bind only
to loopback. No Hetzner machine or real user data is involved.

The proof creates one named tunnel, three unique DNS records, one isolated
Worker, and two exact routes. It compares the existing `.vm` hostname and a flat
hostname at ports 443/8443 with certificate verification enabled, then checks
auth rejection, two local HTTP ports, streaming, WebSocket text/binary after
35 seconds idle, connector restart, and cleanup. Auth is a fixture, not SAM JWT
authorization. The main staging Worker and existing route exclusions are unchanged.

Only `.tmp/report.json` and the nonsecret resource journal are uploaded. Connector
logs and generated tokens remain private on the ephemeral runner. Cleanup runs
both in `finally` and in an independent `always()` step. Resource journal IDs are
needed for operator cleanup if a runner dies abruptly; a successful HTTP response
lost before journaling can still leave resources, discoverable by the unique run
name. The workflow is capped at 12 minutes.

The second stage compiles a temporary Go test host with the real VM-agent JWT,
preview proxy, and Git credential handlers. Synthetic JWKS keys and a fake
Git credential endpoint replace external credentials. A dedicated tunnel
listener marks all requests as relayed; a separate local listener preserves
private Git helper access. It verifies wrong/missing/expired tokens, workspace
and node isolation, preview WebSockets, credential stripping, and rejection of
direct and preview-relayed access to the private credential exchange.

This is transport and handler feasibility evidence. Managed VM provisioning,
cloud-init/firewall rollout, real SAM login/session issuance, Docker bridge
discovery, and incarnation-safe lifecycle cleanup still require integration.
