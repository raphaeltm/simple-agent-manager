# Spike: Node-side Caddy ACME Routing for App Deployment

**Created:** 2026-06-11
**Type:** Spike / Research
**Constraint:** DRAFT PR only — must NOT be merged

## Problem Statement

SAM's app-deployment feature needs a decision on three coupled open questions:
- **Q4** — Edge→node path: CF proxy + Origin CA, CF Tunnel, or node-side ACME?
- **Q6** — Hostname scheme: single-level `{env}--{project}.BASE_DOMAIN` (wildcard cert constraint) or multi-level `{env}.{project}.apps.BASE_DOMAIN` (per-hostname ACME)?
- **Q14** — Proxy choice: Caddy vs nginx vs Traefik for the node data plane?

Current leaning: Caddy as standalone reverse proxy, obtaining/renewing LE certs per hostname via built-in ACME, grey-cloud DNS records.

## Research Findings

### Library docs reviewed
- `05-routing-and-urls.md` — environment-scoped URLs, data plane separation, three edge→node options
- `09-open-questions.md` — Q4/Q6/Q14 coupling, Caddy ACME as strong candidate
- `03-node-lifecycle-and-os-updates.md` — restart-safe agent, proxy independence requirement
- `08-day2-operations.md` — cert renewal paths, expiring material inventory

### Key constraints from docs
1. Data plane (proxy) and management plane (vm-agent) MUST be separate processes (doc 03/05)
2. vm-agent restarts must not drop user traffic (spike item 11 from Q11)
3. Grey-cloud DNS required for ACME (traffic bypasses CF proxy — no DDoS/caching)
4. HTTP-01 needs DNS already pointing at node + port 80 open
5. DNS-01 via CF API avoids node-replacement issuance gap for SAM-domain hostnames
6. Let's Encrypt rate limits: 50 certs per registered domain per 7 days (refills ~1/3.4h)

### CF_TOKEN permissions (verified)
- DNS read: YES (can list records under sammy.party zone)
- DNS write: NO — `CF_TOKEN` returns auth error on POST to dns_records
- **Blocker for on-node experiments**: A separate token with Zone.DNS:Edit is needed to create grey-cloud A records pointing at a test node and for DNS-01 challenge solving

### Caddy DNS-01 with Cloudflare
- Requires custom Caddy build with `caddy-dns/cloudflare` module (`xcaddy build --with github.com/caddy-dns/cloudflare`)
- CF API token needs `Zone.Zone:Read` + `Zone.DNS:Edit` permissions
- Can be configured via JSON admin API for dynamic route/cert management

### Let's Encrypt rate limits math
- 50 new certs per registered domain per 7-day window
- Renewal doesn't count against limit (same FQDN)
- For `sammy.party`: 50 new environment hostnames per week = ~7/day
- For a busy SAM install with 100 environments: initial burst capped at 50/week, full fleet covered in 2 weeks
- Ongoing: renewals are free; new environments rate-limited only in burst scenarios
- LE staging environment has much higher limits for testing (30k certs/week)

## Implementation Checklist

### Phase A: Provision staging node & establish SSH access
- [ ] Create a workspace via staging API to get a provisioned node
- [ ] Get the node IP address
- [ ] SSH into the node (workspace user has sudo)

### Phase B: Install and configure Caddy
- [ ] Install Caddy binary (standard + xcaddy build with cloudflare DNS module)
- [ ] Create systemd unit for Caddy separate from vm-agent
- [ ] Start a test HTTP backend (simple container or netcat)
- [ ] Configure Caddy via admin API to reverse-proxy to the backend
- [ ] Verify reverse proxy works

### Phase C: ACME cert issuance (requires DNS write — may be blocked)
- [ ] Report CF_TOKEN DNS write limitation to user if needed
- [ ] If DNS write token available: create grey-cloud A record for test hostname
- [ ] Test HTTP-01 ACME issuance via Caddy
- [ ] Test DNS-01 ACME issuance via Caddy with cloudflare module
- [ ] Measure issuance timing for both methods
- [ ] If blocked on DNS write: document the procedure theoretically with LE staging env

### Phase D: Graceful config reload (zero-drop)
- [ ] Start continuous curl loop against proxied route
- [ ] Add a new route via Caddy admin API while curl runs
- [ ] Remove a route via Caddy admin API while curl runs
- [ ] Report dropped request count (expect: 0)

### Phase E: Proxy independence from vm-agent
- [ ] Start continuous curl loop against proxied route
- [ ] `systemctl restart vm-agent` — verify zero dropped requests
- [ ] `kill -9 <vm-agent-pid>` — verify zero dropped requests
- [ ] Document results

### Phase F: Node-replacement cert window analysis
- [ ] Document HTTP-01 timeline: DNS repoint → propagation → challenge → issuance
- [ ] Document DNS-01 timeline: DNS repoint → TXT record → challenge → issuance
- [ ] Compare windows; note that DNS-01 avoids the gap entirely for SAM-domain hostnames

### Phase G: Write findings and upload
- [ ] Write `13-caddy-acme-spike-findings.md` with all evidence
- [ ] Upload to SAM library via `upload_to_library`
- [ ] Write recommendation resolving Q4/Q6/Q14

### Phase H: Cleanup
- [ ] Delete test DNS records (if created)
- [ ] Delete test node/workspace on staging

## Acceptance Criteria

- [ ] Findings doc uploaded to SAM library as `app-deployment/13-caddy-acme-spike-findings.md`
- [ ] Recommendation resolves Q4, Q6, Q14 with evidence
- [ ] Any spike scripts in DRAFT PR only
- [ ] Test infrastructure cleaned up
- [ ] CF_TOKEN DNS write limitation reported if blocking

## References

- Library: `research/app-deployment/05-routing-and-urls.md`
- Library: `research/app-deployment/09-open-questions.md`
- Library: `research/app-deployment/03-node-lifecycle-and-os-updates.md`
- Library: `research/app-deployment/08-day2-operations.md`
- [Let's Encrypt Rate Limits](https://letsencrypt.org/docs/rate-limits/)
- [Caddy Admin API](https://caddyserver.com/docs/api)
- [caddy-dns/cloudflare](https://github.com/caddy-dns/cloudflare)
