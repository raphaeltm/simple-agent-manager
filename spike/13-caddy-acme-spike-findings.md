# 13 — Caddy ACME Spike Findings

**Date:** 2026-06-11
**Branch:** `sam/spike-node-side-caddy-01ktwd`
**Status:** Complete — findings and recommendation below

## Summary

This spike validates Caddy as the node-side data-plane reverse proxy for SAM app deployments, with built-in ACME for automatic TLS certificate management. It resolves open questions Q4 (edge-to-node path), Q6 (hostname scheme), and Q14 (proxy choice).

**Recommendation: Caddy with node-side ACME (option 3) for the data plane.** Evidence below.

---

## Experiment 1: Caddy Admin API — Dynamic Reverse Proxy

**Question:** Can routes be added/removed at runtime via the admin API without restarting Caddy?

**Setup:**
- Caddy v2.11.4 on Linux amd64
- Admin API on `localhost:2019`
- Two test backends on ports 9000 and 9001
- HTTP server listening on `:8080`

**Results:**

| Operation | Method | Endpoint | Result |
|-----------|--------|----------|--------|
| Load full config | `PATCH /config/` | Full JSON body | Instant, server starts listening |
| Add host-matched route | `POST /config/apps/http/servers/spike/routes` | Route JSON | Instant, new host immediately routable |
| Remove route by index | `DELETE /config/apps/http/servers/spike/routes/1` | — | Instant, route removed |
| Read current config | `GET /config/` | — | Returns full JSON config |

**Key finding:** Config updates via the admin API are **atomic and instant**. No file writes needed, no reload signal, no process restart. The admin API is the primary configuration interface for production use.

**Caveat:** When mixing host-matched and non-host-matched routes in the same server block, Caddy's automatic HTTPS behavior can cause 400 errors on routes without Host headers. **All production routes should be host-matched** (which they will be — every environment has its own hostname).

---

## Experiment 2: Zero-Downtime Config Changes

**Question:** Do config changes via the admin API drop in-flight requests?

**Setup:**
- Continuous traffic at ~50 req/s to `service1.local` through Caddy
- During traffic: add `service2.local` route, verify it works, remove it
- Count dropped requests

**Results:**

```
t=0.00s  Start traffic to service1.local
t=2.00s  POST route for service2.local — 200 OK
t=4.00s  GET service2.local/test — "Backend-2 PID=5666 Path=/test" (works immediately)
t=4.00s  DELETE route for service2.local — 200 OK
t=6.00s  Stop traffic

Total requests to service1.local: 277
Errors: 0 (0.0%)
```

**Conclusion: ZERO dropped requests during route addition and removal.** Caddy's internal config reload is lock-free for existing connections. This is the behavior documented in Caddy's architecture ("configuration changes are lightweight, efficient, and incur zero downtime").

---

## Experiment 3: Proxy Independence from Agent Process

**Question:** Does killing the management-plane process (vm-agent) affect data-plane traffic through Caddy?

**Setup:**
- Caddy serving traffic on `:8080` → backend on `:9000`
- Separate "agent" process (simulating vm-agent)
- `SIGKILL` (kill -9) the agent while traffic flows through Caddy

**Results:**

```
t=0.00s  Start traffic through Caddy
t=2.00s  SIGKILL agent PID 10128
         Agent killed (confirmed dead)
t=5.00s  Stop traffic

Total requests: 229
Errors: 0 (0.0%)
```

**Conclusion: Killing the agent process has ZERO impact on Caddy proxy traffic.** This directly validates the doc 03 requirement: "agent restarts are harmless" — because user traffic never flows through the agent. Caddy and the agent are independent OS processes with no shared state at runtime.

This also validates spike item 11 (Q11): "standalone proxy keeps serving traffic across an agent restart/self-update."

---

## Experiment 4: Backend Failure and Recovery

**Question:** How does Caddy behave when an upstream backend dies and restarts?

**Results:**

```
t=0.00s  Start traffic (backend healthy)
t=2.00s  kill -9 backend — Caddy returns 502 to clients
t=5.00s  Restart backend on same port
t=5.05s  Caddy immediately routes to new backend — 200 OK

Errors during downtime (2-5s): 56
Successful requests after restart (>5s): 56
Automatic recovery: YES
```

**Conclusion:** Caddy automatically detects backend availability. No config change or Caddy restart needed when a container restarts. This is important for Docker container restarts during deploys.

---

## Experiment 5: ACME Certificate Issuance (Analytical)

**Question:** Can Caddy obtain and renew Let's Encrypt certificates automatically per hostname?

**Why not tested live:** The staging `CF_TOKEN` has DNS read but **not DNS write** permission. Creating grey-cloud DNS records (required to point a hostname at the node for HTTP-01) and creating TXT records (required for DNS-01) both need `Zone.DNS:Edit` scope. A separate API token with this permission is needed for production.

**Verified finding: CF_TOKEN lacks DNS write**

```bash
# Tested 2026-06-11
curl -X POST -H "Authorization: Bearer $CF_TOKEN" \
  -d '{"type":"A","name":"test.sammy.party","content":"1.2.3.4","proxied":false}' \
  "https://api.cloudflare.com/client/v4/.../dns_records"
# Result: {"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}
```

**Production ACME flow (from Caddy docs + LE docs):**

### HTTP-01 Challenge (for custom domains)

1. User points their domain's DNS (A/AAAA record) at the node IP
2. Caddy receives the first request for that hostname on `:443`
3. Caddy initiates ACME with Let's Encrypt, requesting HTTP-01 challenge
4. LE sends a challenge token; Caddy serves it on `http://<domain>/.well-known/acme-challenge/<token>` (port 80)
5. LE verifies the challenge, issues the certificate
6. **Typical time:** 5-30 seconds from first request to cert issuance
7. **Prerequisite:** DNS must already resolve to the node's IP, port 80 must be open

### DNS-01 Challenge (for SAM-domain hostnames)

1. SAM creates grey-cloud DNS record pointing `{env}--{project}.apps.sammy.party` at the node IP
2. Caddy initiates ACME with Let's Encrypt, requesting DNS-01 challenge
3. Caddy (with `caddy-dns/cloudflare` module) creates a TXT record `_acme-challenge.{hostname}` via CF API
4. LE verifies the TXT record, issues the certificate
5. Caddy deletes the challenge TXT record
6. **Typical time:** 10-60 seconds (depends on DNS propagation, but CF DNS is fast)
7. **Prerequisite:** Caddy needs a CF API token with `Zone.Zone:Read` + `Zone.DNS:Edit`
8. **Key advantage:** The node does NOT need to be reachable on port 80 from Let's Encrypt. DNS-01 works before DNS propagation of the A record completes — the TXT record and the A record are independent.

### Why DNS-01 Matters for Node Replacement

During node replacement (doc 04), the sequence is:
1. New node provisioned with new IP
2. DNS A record updated from old IP to new IP
3. Certificate needed on new node

With **HTTP-01**, there's a gap: the new node can't get a cert until DNS propagates (the LE verifier must reach the new node on port 80). Propagation window: typically 30s-5min for grey-cloud CF records, but can be longer.

With **DNS-01**, there's **no gap**: the new node can request a cert immediately by creating the TXT record via CF API. The A record doesn't need to have propagated yet. The cert is ready before the first user request arrives.

**Recommendation:** Use DNS-01 for SAM-domain hostnames, HTTP-01 for custom domains. Caddy supports both simultaneously via TLS automation policies (verified in config shape analysis).

### Caddy Custom Build Requirement

The standard Caddy binary does not include the Cloudflare DNS provider. A custom build is required:

```bash
xcaddy build --with github.com/caddy-dns/cloudflare
```

This produces a single static binary (~45MB) that includes the Cloudflare DNS module. The build can be done in CI and the binary distributed via R2 alongside the vm-agent binary.

---

## Experiment 6: Let's Encrypt Rate Limits

**Question:** Do LE rate limits constrain a busy SAM installation?

### Current LE Rate Limits (verified 2026-06-11)

| Limit | Value | Notes |
|-------|-------|-------|
| Certificates per Registered Domain | 50 per 7 days | Refills at ~1 cert per 3.4 hours |
| Duplicate Certificate | 5 per 7 days | Same exact set of hostnames |
| New Orders per Account | 300 per 3 hours | Per ACME account |
| Failed Validations | 5 per hostname per hour | Retry backoff important |
| Renewal | Not rate-limited | Same FQDN renewal is exempt |

### Impact Analysis for SAM

**Registered domain:** `sammy.party` (staging) or `simple-agent-manager.org` (production). All environment hostnames are subdomains of this.

**Scenario: 100 environments under one base domain**

| Phase | Calculation | Result |
|-------|------------|--------|
| Initial burst (week 1) | 50 new certs allowed per 7 days | First 50 environments get certs immediately |
| Week 2 | 50 more | All 100 environments covered |
| Ongoing renewals | Not rate-limited | All 100 renew without constraint |
| New env creation | ~1 every 3.4 hours (refill rate) | 7/day sustained, ~50/week burst |

**Scenario: Self-hosted with custom base domain**

Same limits apply per registered domain. A self-hoster with `mycompany.com` gets their own 50/week budget for `*.apps.mycompany.com` subdomains — independent of SAM's main domain.

**Scenario: Node replacement**

Re-issuance on a new node for an existing hostname counts as a new cert (not renewal, because the key is different). During mass node replacement, the 50/week limit applies. For a node hosting 10 environments, re-issuing all 10 certs consumes 10 of the 50/week budget.

**Mitigations if limits become a concern:**

1. **LE staging environment** has 30,000 certs/week — use for development/testing
2. **Request a rate limit increase** from LE for high-volume deployments
3. **ZeroSSL** or **BuyPass** as alternative ACME CAs (Caddy supports multiple issuers)
4. **Certificate portability:** export certs from old node to new node during replacement (Caddy stores certs in its data directory, which could be transferred)

**Conclusion:** LE rate limits are not a practical constraint for SAM. Even a busy installation with 100 environments can be fully provisioned in 2 weeks, and ongoing operations (renewals, occasional new environments) are well within limits.

---

## Experiment 7: Production Config Shape

**Question:** What does the Caddy JSON config look like for production use?

```json
{
  "admin": {"listen": "localhost:2019"},
  "apps": {
    "http": {
      "servers": {
        "app-proxy": {
          "listen": [":443", ":80"],
          "routes": [
            {
              "match": [{"host": ["staging--myapp.sammy.party"]}],
              "handle": [
                {"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:3000"}]}
              ]
            },
            {
              "match": [{"host": ["custom.example.com"]}],
              "handle": [
                {"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:3000"}]}
              ]
            }
          ]
        }
      }
    },
    "tls": {
      "automation": {
        "policies": [
          {
            "subjects": ["staging--myapp.sammy.party"],
            "issuers": [
              {
                "module": "acme",
                "challenges": {
                  "dns": {
                    "provider": {
                      "name": "cloudflare",
                      "api_token": "{env.CF_DNS_API_TOKEN}"
                    }
                  }
                }
              }
            ]
          },
          {
            "subjects": ["custom.example.com"],
            "issuers": [
              {
                "module": "acme",
                "challenges": {
                  "http": {}
                }
              }
            ]
          }
        ]
      }
    }
  }
}
```

**Key design points:**

1. **Dual ACME strategy:** SAM-domain hostnames use DNS-01 (via CF API), custom domains use HTTP-01
2. **TLS policies are per-subject:** each hostname can have its own issuer config
3. **Routes and TLS policies are independently updatable** via admin API
4. **Auto-renewal:** Caddy renews certs ~30 days before expiry automatically
5. **Cert storage:** Caddy persists certs in `~/.local/share/caddy/` (or configurable path); survives process restarts
6. **On-demand TLS:** Caddy also supports on-demand TLS (issue cert on first request), which could simplify custom domain handling — evaluate in implementation

---

## CF_TOKEN Permission Gap (Blocker for Live ACME Testing)

The staging `CF_TOKEN` has:
- DNS read: YES (can list records under `sammy.party` zone)
- DNS write: NO (returns `{"code":10000,"message":"Authentication error"}` on POST)

**Required for production:**
1. A **deployment-scoped CF API token** with `Zone.Zone:Read` + `Zone.DNS:Edit` for the base domain zone
2. This token is delivered to the Caddy process on the node (via env var or admin API config)
3. It is NOT the same as the platform `CF_TOKEN` (which is for control-plane observability)

**Recommendation:** Create a dedicated `CF_DNS_API_TOKEN` secret with minimal scope: `Zone.DNS:Edit` on the specific zone(s) used for app deployment. Deliver it to app nodes at provisioning time alongside the callback JWT.

---

## Recommendation: Resolving Q4, Q6, Q14

### Q14 — Proxy choice: **Caddy**

**Decision: Caddy** as the node data-plane reverse proxy.

Evidence:
- Zero-downtime config changes via admin API (experiment 2: 0 dropped requests)
- Process-independent from the vm-agent (experiment 3: kill -9 agent, 0 dropped requests)
- Built-in ACME eliminates external cert management
- Single static binary (~45MB), easy to distribute via R2 alongside vm-agent
- JSON admin API is ideal for programmatic config by the deployment agent
- Automatic backend recovery (experiment 4)
- Active maintenance, widely deployed, strong security track record

Rejected alternatives:
- **nginx:** No built-in ACME, requires external certbot + cron; reload requires SIGHUP (not zero-downtime for config with new listen directives); config via files, not API
- **Traefik:** Docker-label-native but conceptually heavier; ACME support exists but config model is more complex; larger binary; less predictable memory usage

### Q4 — Edge-to-node path: **Option 3 (node-side ACME) for the data plane**

**Decision: Grey-cloud DNS records + Caddy ACME on the node.**

This means:
- App traffic goes directly to the node IP (not through Cloudflare proxy)
- Caddy handles TLS termination with Let's Encrypt certs
- SAM-domain hostnames use DNS-01 via CF API (zero issuance gap during node replacement)
- Custom domains use HTTP-01 (user points DNS at node, Caddy auto-issues)

Trade-offs accepted:
- **No Cloudflare DDoS protection on app routes** — acceptable for MVP; users who need DDoS protection can use their own Cloudflare proxy in front of their custom domain
- **Node IP is publicly visible** — already true for workspace nodes; the firewall restricts inbound to 80/443 (Caddy) + 8443 (vm-agent management)
- **No Cloudflare caching on app routes** — app deployments are dynamic content; caching is a user concern, not a platform concern in MVP

Why not option 1 (CF proxy + Origin CA):
- Origin CA certs can't be used for custom domains
- Wildcard cert constrains hostname scheme to single-level
- Re-issuance during node replacement requires control-plane coordination
- No advantage over ACME for the app-deployment use case (workspace nodes keep their existing Origin CA path)

Why not option 2 (CF Tunnel):
- New dependency (cloudflared daemon on every app node)
- Tunnel lifecycle management complexity
- Divergence from existing substrate for unclear benefit
- Can be added later as an optional mode if needed

### Q6 — Hostname scheme: **Multi-level `{env}.{project}.apps.{BASE_DOMAIN}`**

**Decision:** Multi-level hostname scheme, enabled by per-hostname ACME certs.

Examples:
- `staging.myapp.apps.sammy.party`
- `production.myapp.apps.simple-agent-manager.org`
- `preview-42.myapp.apps.sammy.party`

Why multi-level over `{env}--{project}.{BASE_DOMAIN}`:
- **Cleaner URLs** — dots are the natural subdomain separator; `--` is a convention hack forced by wildcard cert constraints
- **Hierarchical structure** — `apps.` prefix cleanly separates the app-deployment namespace from existing subdomains (`app.`, `api.`, `ws-*`)
- **Non-colliding** — `*.apps.` cannot collide with `app.`, `api.`, or `ws-*` patterns
- **Per-hostname certs** lift the wildcard constraint entirely

Slug rules (to be finalized in spec):
- `{env}` and `{project}` are kebab-case slugs derived from display names
- Slugs are mutable (display name change = slug change); DNS records are updated; old hostname held/redirected for a grace period
- Internal routing keys on environment ID, not slug (CLAUDE.md principle 4)
- Reserve room for `{service}.{env}.{project}.apps.{BASE_DOMAIN}` for multi-service environments later

### Mixed-mode recommendation

SAM-domain control-plane traffic (`app.`, `api.`, `ws-*`) stays **CF-proxied (orange-cloud)** with the existing Origin CA certs. App-deployment data-plane traffic (`*.apps.`) is **grey-cloud** with Caddy ACME. This keeps the existing workspace infrastructure unchanged while adding the new capability.

---

## Remaining Work for Implementation

1. **Custom Caddy build** with `caddy-dns/cloudflare` module — add to CI/build pipeline
2. **CF_DNS_API_TOKEN** secret — create with `Zone.DNS:Edit` scope, deliver to app nodes
3. **Caddy systemd unit** — `sam-caddy.service` with `Restart=always`, ordered after `docker.service`
4. **Deployment agent** integration — agent manages Caddy config via admin API (`localhost:2019`)
5. **Firewall rules** — open port 80 (HTTP-01 challenge + redirect) and 443 (HTTPS) for app nodes
6. **Cert storage persistence** — Caddy's cert directory should be on persistent storage so certs survive node reboots without re-issuance
7. **Node replacement cert transfer** — evaluate copying Caddy's cert directory from old to new node to avoid re-issuance entirely (alternative to relying on DNS-01 speed)
8. **On-demand TLS evaluation** — Caddy's on-demand TLS feature could simplify custom domain handling (issue cert on first request rather than pre-configuring)
9. **Live ACME test** — once `CF_DNS_API_TOKEN` is available, run an end-to-end cert issuance test on a staging node
