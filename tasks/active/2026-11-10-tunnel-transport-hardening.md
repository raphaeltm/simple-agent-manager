# Harden Cloudflare Tunnel transport on every node-creation path, including deployment nodes

SAM task `01M73T9RQ2FZQP1F7806Z7CST4` (replaces cancelled `01M73RT3PA1J13DRC0V1V3NFFY`).
Branch `sam/sams-cloudflare-tunnel-vm-z7cst4`. Follow-up to PR #2615 (cabd2fde8).

## Problem

PR #2615 added opt-in Cloudflare Tunnel transport (`VM_AGENT_TRANSPORT=cloudflare-tunnel`, set on
staging, not production) and verified only the TaskRunner path on Hetzner. On 2026-11-10 two
staging workspace VMs created through direct provisioning failed ~35 s after creation with
`[hetzner] Tunnel for this node incarnation is already being cleaned up` (nodes
`01M73GH65N0542PA0ZV13AW6GN`, `01M73GRDNT3TF4S3Y8T6110ENW`; reported by the PR #2627 agent in
`tasks/backlog/2026-11-10-staging-tunnel-provisioning-masked-failure.md` on its branch).
Deployment nodes are excluded from tunnels entirely.

## Staging evidence (queried 2026-11-10 22:50Z, staging D1 `node_cloudflare_tunnels`)

| node                       | tunnel_id  | status                      | reason                        | attempts                  | pending_create_count | last_error |
| -------------------------- | ---------- | --------------------------- | ----------------------------- | ------------------------- | -------------------- | ---------- |
| 01M73GH65N0542PA0ZV13AW6GN | NULL       | cleanup_pending             | provisioning_failed_before_vm | 8 (still retrying hourly) | 1                    | NULL       |
| 01M73GRDNT3TF4S3Y8T6110ENW | 453a4e0f-… | cleaned (15 s after create) | provisioning_failed_before_vm | 0                         | 0                    | NULL       |

Both node rows are gone (hard-deleted). Two separate defects are visible:

1. **Masked direct-provisioning failure (confirmed).** `NodeLifecycleProvisioning.run()` wraps the
   whole `provisionNode` in a 5 s `AbortController` (`DEFAULT_NODE_PROVISIONING_REQUEST_TIMEOUT_MS`).
   Tunnel mode makes 6-7 sequential Cloudflare calls before `createVM`, so attempt 1 aborts inside
   tunnel setup. The catch in `node-provisioning.ts` releases the row (`releaseTunnelBeforeVm`,
   gated `tunnelJournaled && !resuming && !providerCreateRequested`). A durable allocation's first
   attempt is `!resuming`, but every retry resumes the SAME incarnation
   (`node.runtimeIncarnationId === durable.incarnationId`) and `journalTunnelOwnership` refuses the
   `cleanup_pending` row. The retry can never succeed. The abort reason is a
   `NodeAllocationUncertainError`, which is rethrown before `log.error`/`persistError`, so no cause
   was recorded anywhere (`last_error` NULL).
2. **Immortal cleanup row (new finding).** Node `01M73GH6…` was aborted during the tunnel-create
   POST. `withJournaledTunnelCreate` leaves `pending_create_count=1` on an unobserved response, by
   design ("a POST may commit later"). `cleanupNodeTunnelRow` then refuses to mark the row cleaned
   while the count is > 0, forever, at the capped hourly retry rate. A Cloudflare POST either
   commits within seconds or never; there is no escape path (rule 47 req. 3, rule 71 req. 5).

## Research findings

- `provisionNode` callers (rule 61 enumeration): `durable-objects/node-lifecycle-provisioning.ts`
  (direct: POST /api/workspaces needing a node, POST /api/nodes; durable, signal, 5 s deadline),
  `durable-objects/task-runner/node-provisioning-step.ts` (TaskRunner; no signal; fresh incarnation
  per call), `services/deployment-provisioning.ts` (deployment nodes; no signal),
  `services/session-snapshot-upload-relay.ts` (relay node; no signal). Warm-node reuse and session
  sleep/wake/recovery reach provisioning through the TaskRunner (wake = recovery task) or reuse an
  existing running node (no tunnel work).
- Non-durable callers mint a fresh incarnation per call
  (`provisioningRuntimeIncarnationId = durable?.incarnationId ?? crypto.randomUUID()`), so their
  pre-VM release is correct. Only the durable path resumes one incarnation across attempts.
- A durable resume may already have a VM holding the token from an earlier uncertain `createVM`.
  So "this invocation did not request a VM" is never proof for a durable incarnation. The
  durable owner, not one attempt, decides the incarnation's fate.
- Tunnel setup steps are already idempotent: journal adopt (`INSERT OR IGNORE`), tunnel
  adopt-by-name, ingress PUT, CNAME adopt-exact-match, token GET. Persisted progress: `tunnel_id`,
  then `dns_record_id` + `status='active'`.
- GCP `createVM` POSTs the insert and then polls the operation (`providers/src/gcp.ts`), so a 5 s
  durable deadline also aborts GCP creates mid-operation. Recovery (`recoverNodeAllocation`)
  resumes it. To verify on staging.
- Flaky tests (`node-tunnel-races.test.ts` "does not finalize cleanup while an acknowledged create
  is still in flight", CI run 42894614942; `node-tunnel-lifecycle.test.ts` "fails closed when the
  configured Cloudflare account no longer matches the journal", run 42897664507, draft idea
  `01M73MNS3QD04CTD4P0GH7C8RC`) share one root cause: `runNodeTunnelCleanupSweep` computes `now`
  before `releaseNonLiveNodeTunnels`. The release stamps `cleanup_next_attempt_at = new Date()`,
  which can be later than `now`, so a row released in the same sweep is not due. In the races test
  that decides whether the later `settleNodeTunnels` deletes the just-created tunnel.
- `TUNNEL_FIREWALL_WRITE_FILE` (`packages/cloud-init/src/template-ingress.ts`) calls
  `iptables -C` inside the producer of `iptables-restore`, which holds the xtables lock. Under
  iptables-legacy this deadlocks (filed on `sam/selfhost-pass-2` as
  `tasks/backlog/2026-11-10-tunnel-firewall-xtables-lock-deadlock.md`). GCP and Hetzner both boot
  Ubuntu 24.04 (iptables-nft), so it is latent, but it is a hang in vm-agent `ExecStartPre`.
- Self-host branch `sam/selfhost-pass-2` (PRs #2621/#2625 merged into it, not into main) adds
  `reverse-tunnel` and rewrites the tunnel step in `provisionNode` into
  `node-provisioning-ingress.ts`, and edits `resolveManagedNodeTransport`'s final lines. Keep edits
  to those two spots minimal so the integration merge is a small manual resolve.

## Design: deployment nodes on tunnel transport

Facts (deployment-node map, file:line in the session notes):

- App routes are `r{n}-{svc}-{port}-{envId}.apps.{BASE_DOMAIN}`: grey-cloud A records to
  `nodes.ip_address`, upserted on every release fetch (`deploy-release-callback.ts`), stale routes
  removed after each fetch, on environment delete and on node delete.
- Host Caddy terminates app TLS on :80/:443 with ACME HTTP-01. There is no Cloudflare proxy in the
  path and no custom-hostname (Cloudflare for SaaS) use anywhere.
- Verified custom domains: the user CNAMEs to the route hostname, verification is DoH, and Caddy
  gets their certificate by ACME.
- Non-HTTP ports are not exposed: compose ports are rewritten to `127.0.0.1` routes and
  `network_mode` is denied.
- Staging zone `sammy.party` is on the **Free** plan, with no Advanced Certificate Manager and no
  Total TLS. PR #2615's `experiments/cloudflare-tunnel/FINDINGS.md` measured that direct client TLS
  on a nested proxied hostname (`*.vm.<base>`) fails, while flat hostnames work. App routes are
  nested (`*.apps.<base>`).

Decision. Deployment nodes use the tunnel for the **vm-agent control channel only**: the
`{nodeId}.vm` hostname becomes a tunnel CNAME, the agent port and SSH are dropped publicly, and no
per-node Origin CA certificate is issued. **App ingress stays public**: the same grey-cloud A
records, Caddy and ACME, with 80/443 open. Reasons:

1. Proxying app routes through the tunnel would make every route a proxied nested hostname. That
   fails browser TLS on Free/Pro zones without ACM or Total TLS, so it would need either a
   hostname-scheme change, which breaks every existing route URL and custom-domain CNAME, or paid
   certificates.
2. Custom domains through a tunnel need Cloudflare for SaaS custom hostnames: a new token
   permission (SSL and Certificates edit) plus per-domain DCV. That adds required self-host
   configuration (policy `062763bc`, minimize user-supplied config).
3. Non-HTTP public ports cannot go through a tunnel to anonymous clients at all; that needs
   Spectrum. SAM does not expose them today anyway.
4. The control-channel win is the security-relevant one. Deployment nodes stop holding the
   installation's `*.{BASE_DOMAIN}` Origin CA certificate and stop exposing the agent port.

Consequences to implement: deployment tunnel nodes still need `nodes.ip_address`. Every provider
returns it at create except async-IP providers (Scaleway). For those, allow a heartbeat IP-only
backfill on deployment tunnel nodes without creating a backend A record (that hostname is the
tunnel CNAME), and let `provisionNode` take the awaiting-IP path for a deployment tunnel node with
no IP.
Route ingress therefore needs no per-release tunnel ingress sync. Full app-route tunneling is
recorded as a follow-up idea with the two prerequisites above.

## Implementation Checklist

- [ ] Durable resume never meets a self-released row: release pre-VM only for non-durable callers
      (`!durable && !providerCreateRequested`), with the reasoning in a comment
- [ ] Record the failure cause before any rethrow, abort included: structured
      `node_provisioning.attempt_failed` log (phase, durable, aborted, reason) and journal
      `last_error` (`recordNodeTunnelProvisioningError`)
- [ ] Phase tracking in `ensureNodeTunnelForProvisioning` so the recorded cause names the step
- [ ] Resumable fast path: an `active` row with tunnel + DNS ids skips ingress PUT and CNAME search
      (verifies the DNS record by id, then fetches the token)
- [ ] Durable attempt deadline covers tunnel setup: request timeout + `vmTunnels.provisioningBudgetMs`
      (admin setting, default 20 s) when the incarnation uses tunnel transport; per-call timeout
      unchanged
- [ ] Pending-create escape: migration `0232` adds `pending_create_last_at`; claim stamps it;
      cleanup treats an unobserved create older than `vmTunnels.pendingCreateSettleMs` (default
      15 min) as settled once its own inventory is deleted; anchored on
      `COALESCE(pending_create_last_at, created_at)` so existing stranded rows recover
- [ ] Flake fix: releases write `cleanup_next_attempt_at = NULL` (already due); controlled-ordering
      regression test
- [ ] xtables-lock fix in `TUNNEL_FIREWALL_WRITE_FILE` (compute the `-C` check before
      `iptables-restore` starts)
- [ ] Deployment nodes: include them in `resolveManagedNodeTransport`; awaiting-IP path for
      deployment tunnel nodes with no IP; heartbeat IP-only backfill for deployment tunnel nodes
- [ ] Caller enumeration test for `provisionNode` (machine-checked, rule 61)
- [ ] Tests per entry point: direct (Workers DO test, slow Cloudflare forcing an abort mid tunnel
      setup, converges on attempt 2), deployment provisioning with tunnel, relay node with tunnel,
      TaskRunner (existing #2615 coverage, re-verified)
- [ ] Docs: `node-tunnel-config.ts` header, public docs for tunnel transport and deployment nodes,
      self-hosting notes
- [ ] Follow-up idea: full app-route tunneling (Cloudflare for SaaS + flat hostnames)

## Throughput and worst case (rule 81)

Filled in after implementation; see the PR body.

## Staging scenario matrix

Filled in during Phase 6, with the provider on every row.

## Spend tracking

| Run | Provider | VMs x minutes | Est. cost |
| --- | -------- | ------------- | --------- |

## Acceptance Criteria

- [ ] Direct provisioning (POST /api/nodes, POST /api/workspaces needing a node) with tunnels
      succeeds on staging on GCP and Hetzner, including an attempt aborted mid tunnel setup
- [ ] Every abort or failure in tunnel setup records a cause in logs and the journal
- [ ] No journal row can stay `cleanup_pending` forever because of an unobserved create
- [ ] A deployment node on GCP provisions with tunnel transport, applies a real app release, serves
      it over its route hostname, and tears down with its journal cleaned and DNS gone
- [ ] Node deletion and the cleanup sweep converge (journal `cleaned`, no tunnel or CNAME left)
- [ ] Warm tunnel node reuse works
- [ ] Flaky tunnel tests are deterministic
- [ ] Production `VM_AGENT_TRANSPORT` untouched

## References

- `.claude/rules/81`, `47`, `61`, `62`, `71`, `75`; `apps/api/.claude/rules/45`, `58`
- `experiments/cloudflare-tunnel/STAGING-E2E.md`, `FINDINGS.md`
