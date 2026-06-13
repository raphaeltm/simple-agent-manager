# Research: Network-Proxy Secret Injection for Dev Containers

> Research/design spike. Not a committed feature. Answers the question: is there an
> off-the-shelf way to run dev containers where secrets are injected at the network
> layer by an egress proxy (instead of as env vars), and can we do it ourselves?

## The question

> "More and more tools do network proxying and inject secrets at request time for AI
> agents (Databricks Omnigent, Docker Sandbox). Is there an off-the-shelf solution to
> run Docker containers / dev containers this way, or can we do it manually? Instead of
> injecting secrets into the environment, inject a placeholder we replace during network
> requests in a proxy, and control the network for the dev container."

Short answer: **Yes to both.** The pattern is mature enough to have a name ("the
secretless / credential-proxy pattern"), there are off-the-shelf products (Docker
Sandboxes, Databricks Omnigent) and OSS components (CyberArk Secretless Broker,
mitmproxy, HashiCorp Vault/Boundary) that implement pieces of it, and SAM **already
implements the placeholder-swap pattern for one traffic class** (LLM API calls). The
generalization to *all* egress is a known, buildable design — not novel research.

## The core pattern (what all these tools share)

Every implementation decomposes into the same three mechanisms. The hard part is never
one of them in isolation; it's making all three hold at once.

1. **Force all container egress through a proxy.** The container cannot reach the
   internet directly. Options: `HTTP_PROXY`/`HTTPS_PROXY` env (cooperative), iptables
   REDIRECT/TPROXY in the container's network namespace (transparent, enforced), or an
   internal-only Docker network whose only route out is the proxy.
2. **Deny-by-default egress allowlist.** Only explicitly-listed destination domains are
   reachable. Private/loopback/link-local ranges blocked. Raw TCP/UDP/ICMP blocked. This
   is what stops a compromised agent from exfiltrating the swapped-in secret to an
   attacker domain.
3. **Inject the real secret at the proxy on approved requests.** The container holds a
   *placeholder/reference* (e.g. `__github_token__`, or nothing at all). On an approved,
   allowlisted request the proxy substitutes the real credential into the auth header (or
   opens the upstream connection with it) before forwarding. The real value never lands in
   the container's env, filesystem, or process table.

The TLS wrinkle: to rewrite an `Authorization` header on an HTTPS request, the proxy must
terminate TLS (MITM) — which means installing the proxy's CA cert as trusted inside the
container. Tools that *only* open the upstream connection with the credential (TCP-level
brokers, or "base URL points at proxy" designs) avoid MITM but require the client to be
configured to talk to the proxy rather than the real endpoint.

## What SAM already does (the precedent)

SAM already ships the placeholder-swap pattern — scoped to LLM traffic only:

- **`sam` provider mode** injects the literal sentinel `__platform_proxy__` as the agent's
  API key instead of a real key, plus an `inferenceConfig.baseURL` pointing at SAM's proxy
  (`https://api.${BASE_DOMAIN}/ai/v1` or `/ai/anthropic`). See
  `apps/api/src/routes/workspaces/runtime.ts` (the `apiKey: '__platform_proxy__'` /
  `apiKeySource: 'callback-token'` branch, ~L457-503). The agent authenticates to the SAM
  AI proxy with its workspace callback token; the proxy injects the real upstream key
  server-side. The real Anthropic/OpenAI key never enters the container.
- **Passthrough proxy** uses a `{wstoken}` placeholder embedded in the base URL
  (`/ai/proxy/{wstoken}/anthropic`) that the VM agent substitutes with the callback token
  at injection time (`runtime.ts` ~L379-398).

So the architecture insight is: **SAM has already validated mechanism #3 for one traffic
class via app-level base-URL override.** What the user is asking about is generalizing it
from "per-tool base URL override for LLM calls" to "network-level interception of all
egress" so the same trick covers GitHub, npm, container registries, and arbitrary APIs.

### Why this matters for SAM specifically (existing pain points it would erase)

The current env-var/file injection model is the subject of multiple open hardening tasks.
A network-proxy model makes these classes of bug structurally impossible rather than
patched:

- `tasks/backlog/2026-03-18-docker-exec-env-token-exposure.md` — `docker exec -e KEY=VALUE`
  in `packages/vm-agent/internal/acp/process.go` leaks `ANTHROPIC_API_KEY`, `GH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN` into `/proc/<pid>/cmdline` on the host. If the container only
  ever holds a placeholder, there is nothing sensitive to leak.
- `tasks/backlog/2026-06-07-harden-github-token-injection.md` — wants to "reduce static
  `GH_TOKEN` exposure" and "remove durable workspace callback-token literals from generated
  git credential helpers." A proxy that injects the GitHub token per-request removes the
  static token from the container entirely.
- `tasks/backlog/2026-06-09-git-credential-loopback-container-binding.md` and
  `tasks/backlog/2026-03-17-mcp-token-do-storage-security.md` — same family: credentials
  materialized where the agent can read them.

## Off-the-shelf solutions

| Solution | Type | Forces egress how | Injects how | TLS MITM | Fit for SAM |
|---|---|---|---|---|---|
| **Docker Sandboxes (`sbx`)** | Product (Docker) | microVM; all HTTP/S through host proxy; deny-by-default | Forward proxy adds auth headers; values never enter VM | Yes (forward mode) | High — Docker-native, but microVM model differs from SAM's container-on-VM |
| **Databricks Omnigent** | Product (Databricks) | OS sandbox intercepts/transforms requests | Egress proxy injects token only on approved requests | Yes | Reference design only; not standalone/self-hostable for SAM |
| **CyberArk Secretless Broker** | OSS (Conjur) | App connects to local broker instead of service | Broker opens upstream conn with creds from a store | No (TCP broker) | High for DB/SSH/HTTP-with-known-endpoints; weaker for arbitrary domains |
| **HashiCorp Vault Agent / Boundary** | OSS | Vault Agent = sidecar/file templating; Boundary = brokered access | Renders secrets to files / brokers sessions | N/A | Good *secret store* side; not an egress MITM by itself |
| **mitmproxy** | OSS | You wire iptables/HTTP_PROXY | Python addon rewrites headers per-flow | Yes (own CA) | High — the canonical DIY building block |
| **Pipelock / iron-proxy (PipeLab)** | OSS | Forward proxy / hook interception | "Boundary secret rewriting" + content inspection | Yes | Emerging; AI-agent-specific; worth tracking |

### Notes per option

- **Docker Sandboxes** is the closest off-the-shelf match conceptually: "All HTTP and HTTPS
  traffic leaving a sandbox passes through a proxy on your host that enforces the network
  policy… the host-side proxy intercepts outbound API requests and injects authentication
  headers… credential values are never stored inside the VM. Only domains explicitly listed
  in the policy are reachable." Caveat: it's built around per-sandbox microVMs with their own
  Docker daemon and kernel, and the credential injection is part of the `sbx` CLI / Docker
  Agent product surface — not obviously consumable as a standalone library you drop next to
  an existing devcontainer. SAM runs containers on a shared VM (node) rather than per-agent
  microVMs, so adopting `sbx` wholesale would change the isolation model.
- **Databricks Omnigent** is a *reference* that proves the pattern at a serious vendor
  ("preventing an agent from seeing a GitHub security token while injecting it only in the
  egress proxy on approved requests"), but it is a managed harness, not a self-hostable
  component. Use it as design validation, not as a dependency.
- **CyberArk Secretless Broker** is the most directly reusable OSS piece for the
  *injection* mechanism when the set of upstreams is known (databases, SSH, specific HTTP
  APIs). The app connects to `localhost:<port>` with no credentials; the broker pulls the
  real credential from a store and streams the authenticated connection. It is a TCP/HTTP
  connection broker, not a transparent catch-all egress MITM, so it pairs best with a
  separate deny-by-default firewall.
- **HashiCorp Vault** solves the *store + rotation + short-TTL* half (mint a 5-minute
  GitHub token on demand, which SAM partially does via the callback mint endpoint already).
  Vault Agent's file/sidecar templating is still "secret lands in the container," so it is
  complementary to, not a replacement for, the egress-proxy idea.
- **mitmproxy** is the pragmatic DIY core: transparent mode + a small Python addon that
  matches allowlisted hosts and rewrites the `Authorization` header from a placeholder to
  the resolved secret, with everything else denied. Requires installing mitmproxy's CA into
  the container's trust store (and into language-specific stores: `NODE_EXTRA_CA_CERTS`,
  `pip`'s `REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE`, `git http.sslCAInfo`, Go's
  `SSL_CERT_FILE`). This CA-trust requirement is the main friction.

## The two design axes you actually choose between

**Axis A — How is traffic forced through the proxy?**

- *Cooperative* (`HTTP_PROXY`/`HTTPS_PROXY` env): trivial to set up, but a process can just
  ignore the env var and connect directly. Not a security boundary on its own.
- *Transparent / enforced* (iptables REDIRECT/TPROXY in the container netns, or an
  internal-only Docker network with the proxy as the sole gateway): the container *cannot*
  bypass it. This is what makes deny-by-default real. SAM already runs node-local Caddy and
  per-environment Docker bridge networks (`apps/api/src/services/compose-renderer.ts` —
  `sam-internal` bridge), so an enforced egress gateway is a natural extension of existing
  network topology.

**Axis B — Does the proxy need to read/modify the request body or headers (MITM), or just
open the upstream connection?**

- *Header rewrite on HTTPS* (GitHub `Authorization: token …`, arbitrary API keys): needs
  TLS termination + trusted CA in the container. Most flexible, most setup.
- *No MITM*: only works when the client is willing to talk to the proxy as its endpoint
  (the SAM LLM `baseURL` trick), or for TCP-level brokering (Secretless). No CA install,
  but every credential type needs the client to be pointed at the broker.

## DIY recipe for SAM (if built in-house)

This maps cleanly onto SAM's existing VM-agent + Docker + Caddy stack:

1. **Egress gateway container per node** (or per environment): a small proxy (mitmproxy, or
   a Go proxy reusing the existing AI-gateway code in `packages/vm-agent/internal/acp/`).
2. **Network enforcement**: put workspace containers on an internal Docker network whose
   only egress route is the gateway, *or* add iptables rules in the workspace container's
   netns redirecting :80/:443 to the gateway. SAM already manages container networks in the
   compose renderer, so this is an additive change there.
3. **Placeholder injection**: continue the `__platform_proxy__` precedent — inject
   `__github_token__`, `__npm_token__`, etc. as the only "secrets" in the container env /
   git credential helper. The git credential helper already exists
   (`packages/vm-agent/internal/server/git_credential.go`); it would return a placeholder.
4. **Per-request resolution**: gateway matches `(workspaceId, destination host)` →
   resolves the real, freshly-minted, narrowly-scoped credential from the control plane
   (reusing the existing callback-token mint path in
   `apps/api/src/routes/workspaces/runtime.ts` and the GitHub token mint endpoint), swaps
   it into the auth header, forwards. The gateway authenticates to the control plane with
   the workspace callback token — so the *placeholder→real* authority lives at the network
   boundary, exactly where the github-token-hardening task wants it.
5. **CA trust bootstrap**: install the gateway CA into the devcontainer during provisioning
   (cloud-init / devcontainer feature) and set the language CA env vars. This is the main
   net-new cost.
6. **Deny-by-default allowlist**: per-project allowlist of reachable domains; everything
   else 403 at the gateway. Pairs with the existing OS-level firewall work
   (`tasks/archive/2026-03-21-os-level-firewall-cloud-init.md`).

## Recommendation

- **Don't adopt a product wholesale.** Docker Sandboxes would change SAM's isolation model
  (per-agent microVMs vs. containers-on-shared-VM); Omnigent isn't self-hostable.
- **Do build the in-house egress gateway**, because (a) SAM already owns the proxy half for
  LLM traffic and the credential-mint half for GitHub, so this is *connecting two existing
  systems* plus network enforcement, not greenfield; and (b) it directly closes three open
  security hardening tasks instead of patching them.
- **Reuse, don't reinvent**: CyberArk Secretless Broker for any TCP/DB/SSH upstreams;
  mitmproxy as the HTTPS-MITM core if we don't extend the existing Go gateway; the existing
  callback-token mint path as the resolution backend.
- **Suggested next step**: a narrow spike — gate *GitHub HTTPS egress only* through a
  node-local proxy that swaps a `__github_token__` placeholder for a freshly-minted scoped
  token, with deny-by-default for everything else. This proves CA trust + enforcement +
  per-request mint on the single most valuable credential before generalizing. It also
  composes with `tasks/backlog/2026-06-07-harden-github-token-injection.md` rather than
  competing with it.

## Open questions / caveats

- **CA trust friction**: every toolchain in the devcontainer must trust the gateway CA.
  Custom user devcontainers may bring tools we don't pre-configure. Need a bootstrap that
  covers Node, Python, Go, git, curl, and arbitrary binaries (system trust store).
- **Performance**: terminating + re-originating TLS for all egress adds latency and CPU per
  node. The LLM proxy already does this for one stream; all-egress is more.
- **Streaming / websockets / non-HTTP**: registries, SSH-based git, websocket APIs need
  per-protocol handling. Secretless covers TCP; HTTP MITM covers HTTP/S; raw protocols need
  explicit support or denial.
- **Bypass surface**: enforcement must be in the container netns (iptables/internal
  network), not just `HTTP_PROXY` env, or a malicious agent bypasses it.
- **Isolation model**: this is an egress-confidentiality control, not a substitute for
  process/kernel isolation. It assumes the container itself is already the trust boundary.

## Sources

- [Introducing Omnigent (Databricks Blog)](https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents)
- [Connect agents to external services — Unity Catalog connections proxy (Databricks Docs)](https://docs.databricks.com/aws/en/generative-ai/agent-framework/external-connection-tools)
- [Docker Sandboxes — Isolation layers (Docker Docs)](https://docs.docker.com/ai/sandboxes/security/isolation/)
- [Docker Sandboxes — Security model (Docker Docs)](https://docs.docker.com/ai/sandboxes/security/)
- [Running AI agents safely in a microVM using docker sandbox (Andrew Lock)](https://andrewlock.net/running-ai-agents-safely-in-a-microvm-using-docker-sandbox/)
- [CyberArk Secretless Broker](https://secretless.io/)
- [cyberark/secretless-broker (GitHub)](https://github.com/cyberark/secretless-broker)
- [Connect to Any API Without Exposing Your Secrets — Secretless Broker (CyberArk Developer)](https://developer.cyberark.com/blog/connect-to-any-api-without-exposing-your-secrets-secretless-broker/)
- [Vault Agent Injector (HashiCorp Developer)](https://developer.hashicorp.com/vault/docs/deploy/kubernetes/injector)
- [mitmproxy — Proxy Modes (transparent / egress)](https://docs.mitmproxy.org/stable/concepts/modes/)
- [Transparent proxy and filtering on k8s (GoogleCloudPlatform/community)](https://cloud.google.com/community/tutorials/transparent-proxy-and-filtering-on-k8s)
- [AI Egress Proxy: Control What Your Agents Send (PipeLab)](https://pipelab.org/learn/ai-egress-proxy/)
- [Agent Security Control Layers (PipeLab)](https://pipelab.org/learn/agent-security-control-layers/)
- [luckyPipewrench/pipelock — AI agent firewall (GitHub)](https://github.com/luckyPipewrench/pipelock)
- [Docker MCP Gateway (Docker Blog)](https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/)
