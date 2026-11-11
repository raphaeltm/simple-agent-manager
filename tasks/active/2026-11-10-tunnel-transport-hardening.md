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

- [x] Durable resume never meets a self-released row: release pre-VM only for non-durable callers
      (`!durable && !providerCreateRequested`), with the reasoning in a comment
- [x] Record the failure cause before any rethrow, abort included: structured
      `node_provisioning.attempt_failed` log (phase, durable, aborted, reason) and journal
      `last_error` (`recordNodeTunnelProvisioningError`)
- [x] Phase tracking in `ensureNodeTunnelForProvisioning` so the recorded cause names the step
- [x] Resumable fast path: an `active` row with tunnel + DNS ids skips ingress PUT and CNAME search
      (verifies the DNS record by id, then fetches the token)
- [x] Durable attempt deadline covers tunnel setup: request timeout + `vmTunnels.provisioningBudgetMs`
      (admin setting, default 20 s) when the incarnation uses tunnel transport; per-call timeout
      unchanged
- [x] Pending-create escape: migration `0233` (0232 is taken by the self-host branch) adds `pending_create_last_at`; claim stamps it;
      cleanup treats an unobserved create older than `vmTunnels.pendingCreateSettleMs` (default
      15 min) as settled once its own inventory is deleted; anchored on
      `COALESCE(pending_create_last_at, created_at)` so existing stranded rows recover
- [x] Flake fix: releases write `cleanup_next_attempt_at = NULL` (already due); controlled-ordering
      regression test
- [x] xtables-lock fix in `TUNNEL_FIREWALL_WRITE_FILE` (compute the `-C` check before
      `iptables-restore` starts)
- [x] Deployment nodes: include them in `resolveManagedNodeTransport`; awaiting-IP path for
      deployment tunnel nodes with no IP; heartbeat IP-only backfill for deployment tunnel nodes
- [x] Caller enumeration test for `provisionNode` (machine-checked, rule 61)
- [x] Tests per entry point: direct (Workers DO test, slow Cloudflare forcing an abort mid tunnel
      setup, converges on attempt 2), deployment provisioning with tunnel, relay node with tunnel,
      TaskRunner (existing #2615 coverage, re-verified)
- [x] Docs: `node-tunnel-config.ts` header, public docs for tunnel transport and deployment nodes,
      self-hosting notes
- [x] Follow-up idea: full app-route tunneling (Cloudflare for SaaS + flat hostnames): idea `01M745ZZ5BP6CPNRT9P95NWF3Q`
- [x] Staging-found: a create marked as requested is not cancelled by the attempt deadline
      (`ca425a898`); the mark is persisted before the POST (`providerCreateRequested`)
- [x] Staging-found: GCP recovery adopts its VM (zone `location`, `getVM` observed hardware,
      exact re-read) (`7e1d7334d`)
- [x] Staging-found: recovery and the durable publish tail are not cut by the deadline; the
      identity is recorded first; the public-IP DNS create keeps the deadline (`b98b460ed`,
      `94ef8bd45`)
- [x] Staging-found: GCP deployment hardening refreshes the iptables snapshot before installing
      `iptables-persistent` (`f4ba88f09`)
- [x] Owner-attested manual deletion releases the node's tunnel inline (`56286ae15`)
- [x] Entry-point tests through `provisionDeploymentNode` and `ensureSessionSnapshotUploadRelay`
      (`6e078ff50`)
- [x] Backlog: strict providerless deletion for non-Hetzner providers
      (`tasks/backlog/2026-11-11-providerless-node-deletion-non-hetzner.md`)

## Throughput and worst case (rule 81)

**Durable direct provisioning.**
- Each attempt's deadline is `NODE_PROVISIONING_REQUEST_TIMEOUT_MS` (5 s) plus `vmTunnels.provisioningBudgetMs` (20 s) = 25 s.
- Each Cloudflare or provider request is still capped at 5 s.
- Attempts run every 30 s, bounded by 30 attempts or 15 min.
- Tunnel setup is six sequential Cloudflare calls (list, create, ingress PUT, DNS list, CNAME create, token) plus about eight D1 writes. Typically that is 2-4 s, so the tunnel and the VM finish in one attempt.
- Progress persists per step: `tunnel_id` after the create, then `status='active'` after ingress and CNAME. A resumed `active` row needs only a DNS re-check and the token (two calls).
- Outer limit, with every call close to its 5 s timeout:
  - Attempt 1 finishes the list, create, PUT and DNS list (20 s), records `tunnel_id`, and is cut.
  - Attempt 2, 30 s later, does the PUT, CNAME and token (15 s), then the create POST.
  - Worst case is therefore about 2 attempts, roughly 60 s, before the provider create starts.
- The provider phase (all providers, not tunnel-specific):
  - Hetzner's create returns in 1-3 s.
  - GCP's create POSTs and then polls the insert operation (10-40 s), so the 5 s request share usually cuts it after the POST.
  - `providerCreateRequested=true` is recorded before the POST, so the next attempt reconciles the exact inventory and adopts the VM. GCP direct provisioning therefore normally takes 2 attempts (+30 s).

**Unobserved creates.**
- A row with `pending_create_count > 0` settles once `vmTunnels.pendingCreateSettleMs` (15 min) has passed since the last unobserved POST.
- Cleanup backoff doubles from 1 min, so the interval spanning the window's end is at most the time already elapsed.
- Worst case to cleaned is therefore about 2 × settle = 30 min at the defaults (bounded by `cleanupBackoffMaxMs` = 1 h for larger windows). Tested in `node-tunnel-hardening.test.ts` with the real sweep driven sweep by sweep.

**Cleanup sweep.**
- Each 5-minute cron tick handles up to `cleanupBatchSize` = 10 rows within `cleanupSweepBudgetMs` = 30 s.
- At most 5 Cloudflare calls per row, about 0.3 s each when healthy: 10 rows per tick, or 120 rows/h.
- At the outer limit (every call at the 10 s cleanup timeout), about 1 row per tick. The remaining rows stay due, with nothing lost.
- At 1,000 tunnels per account (Cloudflare quota, inactive tunnels counted), even the degraded rate clears a 100-row backlog in under 9 h.

## Staging scenario matrix

All rows ran on `app.sammy.party` (staging, `VM_AGENT_TRANSPORT=cloudflare-tunnel`) as the smoke user.

| # | Provider | Path (entry point) | Fault injected | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| S1 | GCP `europe-west1-b` e2-medium | Direct `POST /api/nodes` (NodeLifecycle durable) | `vmTunnels.provisioningBudgetMs=1`, i.e. the incident's 5 s deadline | **Tunnel part PASS; found and fixed a new defect** | Node `01M73XZ9JPMCMEGPYCNEPCV62E` (build 4a… run 42924408696): <ul><li>23:51:33 `attempt_aborted` in phase `ingress` (the incident). The row was not released.</li><li>23:52:02 the resumed attempt finished the tunnel (`node_tunnel.provisioned`), then `attempt_aborted` in `provider_create`.</li><li>23:52:30 `provisioning_resumed` (fast path, 2 calls).</li><li>23:53:01 onward, every attempt failed with `Allocation inventory has no exact match; a second create is forbidden`. The 5 s cut landed after the create-requested mark but before GCP accepted the POST (in its OAuth token exchange), and no VM existed in GCP.</li><li>Fixed in `ca425a898`: once marked, a durable create is not cancelled by the attempt deadline.</li></ul> |
| S1-teardown | GCP | `DELETE /api/nodes/:id`, then `POST /api/nodes/:id/manual-deletion` | Providerless GCP node | PASS (pre-existing gap recorded) | <ul><li>Strict delete returns 409 for a providerless node on any non-Hetzner provider (`reconcileStrictProviderlessVm`: inventory completeness is guaranteed only for Hetzner). That is pre-existing, so it is filed as backlog.</li><li>Owner attestation returned 200. The sweep cleaned the journal at 00:01:05Z, 75 s later, and the `{node}.vm` CNAME is gone.</li><li>Inline release on attestation was added in `56286ae15`.</li></ul> |
| S10 | Hetzner `fsn1` cx23 | Direct `POST /api/nodes`: **the incident's exact path and condition** | `vmTunnels.provisioningBudgetMs=1` (5 s attempts) | **PASS** | Node `01M745JK3DMWP97N8ZCD4Q79T6`: <ul><li>02:04:25 `attempt_aborted` in `ingress`. The row was not released, where pre-fix it went `cleanup_pending` and was refused for good.</li><li>02:04:54 tunnel provisioned; cut before the create mark.</li><li>02:05:24 fast-path resume, one Hetzner create; `running` at 02:05:26 with provider id 175589457.</li><li>Journal `active`, CNAME `→ ba0292a1….cfargotunnel.com`.</li><li>The budget was reset to its default afterwards.</li></ul> |
| Sweep convergence | GCP and Hetzner | Cron sweep after teardown | none | **PASS** | <ul><li>S4 (GCP): journal `cleaned` at 01:40:51, CNAME gone (deleted 01:36:46).</li><li>S9 (Hetzner): `cleaned` at 01:51:10, CNAME gone (deleted 01:49:07).</li><li>S1: `cleaned` at 00:01:05.</li><li>S8 deployment environment delete: `nodeDeleted:true`, `dnsRecordsDeleted:1` (app route); journal `cleanup_pending`/`runtime_terminated`, cleaned by the next tick.</li><li>Each finished within 1-2 cron ticks.</li></ul> |
| S8 | GCP `europe-west1-b` e2-medium | Deployment node: environment `tunnel-gcp`, compose release (nginx) | none | **Tunnel PASS; release FAIL on a GCP-only defect, fixed** | Release `01M744SA02PCWFC9MFPDRS667J` → deployment node `01M744SC4N3WFSYFHYDPQQJZA1`: `transport=cloudflare-tunnel`, `running`/`healthy`, journal `active`, CNAME in place; Caddy installed; agent ready at 01:53:21Z. <br>`compose up` then failed: `Failed to Setup IP tables … DOCKER-FORWARD: No chain/target/match by that name`. Cause: deployment hardening installs `iptables-persistent`, whose postinst restores a pre-Docker `rules.v4` with a filter-table flush. GCP's Ubuntu image installs Docker after cloud-init's first firewall run; Hetzner's docker-ce image does not. Fixed in `f4ba88f09` (refresh the snapshot before the install). <br>Docker Hub returned 429 from Worker IPs for `nginx:alpine`, so the release uses `public.ecr.aws/nginx/nginx:stable-alpine` (unrelated to tunnels). |
| S9 | Hetzner `fsn1` (S6's node) | Warm-node reuse: delete the workspace, then a new TaskRunner task with no node pinned | none | **PASS** | Task `01M744GXEMN3XP48E2CC59ZPD8` → workspace `01M744H5H52X9EHMJ5C4CSE1V3` on the same node `01M743ZGW2EVZ2QTJ0ERYMTXJM`, with 0 nodes created after 01:45Z. |
| S9-teardown | Hetzner | Delete the workspace, then `DELETE /api/nodes/:id` | none | **PASS** | Both returned 200 (01:49:07); `GET` on the node then returns 404. The journal and CNAME are cleaned by the sweep (verified below). |
| S6 | Hetzner `fsn1` cx23 | TaskRunner `POST /tasks/submit` (chat, fresh node) | none (waited `waiting_for_node_capacity` while the 3-node pool cap was held by the S2/S3 rows) | **PASS** | Task `01M742STVZG7TZXP45AB7Z96VB` → node `01M743ZGW2EVZ2QTJ0ERYMTXJM` (`running`/`healthy`, journal `active`, CNAME `→ 36be9c99….cfargotunnel.com`) → workspace `01M74497ZRSNT53CW1MMCV7Z46` `running`. The agent replied `TUNNEL-OK Linux`. On 5.75.225.129, 8443 (the agent port, from `VM_AGENT_PORT`), 8444 and 22 time out (dropped); 8080, 80, 443 and 9999 return RST (closed, no listener). |
| S5 | GCP (S4's node) | Direct `POST /api/workspaces` onto an existing tunnel node | none | **PASS** | Workspace `01M742RXKJAXSWRJ5BCY2MNV1H` reached `running` about 3 min after create. Through the tunnel, `GET /api/workspaces/:id/ports` returned 200 (container resolved, scanner active) and `GET /api/nodes/:id/containers` listed the devcontainer. (The first try, at the default `medium` size, got 409: 4 GB minus the 1 GB reserve cannot fit it. That is correct.) |
| S7 | GCP (S4's node) | TaskRunner `POST /tasks/submit` with `nodeId`, reusing a running tunnel node | none | **PASS** | Task `01M743MGX45KRMRXRA7MMF9R4K` → workspace `01M743MS90T8QQHMYR1D95MAPV` on the same node, ending `awaiting_followup`. The agent replied "kernel name `Linux`, kernel release `7.0.0-1017-gcp`, GCP host confirmed". |
| S4-teardown | GCP | Delete both workspaces, then `DELETE /api/nodes/:id` (strict, with provider id) | none | **PASS** (sweep pending at write time) | <ul><li>All three returned 200 (01:36:48).</li><li>The GCP instance is gone from `sam-staging-infra`, verified with the read-only WIF.</li><li>The node row is gone.</li><li>The journal moved to `cleanup_pending`/`runtime_terminated` at 01:36:46; the CNAME is removed by the cron sweep.</li></ul> |
| S4 | GCP `europe-west1-b` e2-medium | Direct `POST /api/nodes` | Budget 1 ms for the first 3 min (deploy `b98b460ed`), then the default 20 s | **PASS** | Node `01M7423W5F22SNTM5Y69ZFM6DB`: <ul><li>Cut in `ingress` (01:03:57), then before the mark (01:04:27).</li><li>Exactly one GCP VM was created, and recovery adopted it, recording `provider_instance_id` 9026316479324094935 under 5 s attempts.</li><li>With the default budget, the publish completed at 01:07:25: node `running`/`healthy`, journal `active`, `last_error` cleared.</li><li>CNAME `→ 2a4f38c6….cfargotunnel.com` proxied.</li><li>`GET /api/nodes/:id/system-info` returned 200 through the tunnel.</li><li>Public 8080, 8443, 8444 and 22 on 34.156.135.177 all time out (GCP firewall plus tunnel iptables).</li><li>Heartbeats log `ip_backfill_skipped_tunnel_node`.</li></ul> |
| S2 | GCP `europe-west1-b` e2-medium | Direct `POST /api/nodes` | Budget 1 ms (deploy `ca425a898`) | **Tunnel and create PASS; found and fixed a GCP recovery defect** | Node `01M73Z88EPJGKF55AJ01TZCWR8`: <ul><li>00:13:54 cut in `ingress`.</li><li>00:14:25 cut at the last check before the mark, so nothing was created.</li><li>00:14:52 fast-path resume; the marked create ran to completion past the deadline. GCP instance `node-01m73z88…` was created at 00:15:06Z, exactly once.</li><li>Every later attempt: `Allocation inventory identity or native hardware is inconsistent`. GCP list results had no `location` and no observed hardware. Fixed in `7e1d7334d`.</li><li>The VM booted and heartbeated through the tunnel (node `running`/`healthy` at 00:24Z) with no SAM instance id. The intent exhausted at 00:28Z, so the VM needed deleting by hand.</li></ul> |
| S3 | GCP `europe-west1-b` e2-medium | Direct `POST /api/nodes` | Budget 1 ms (deploy `7e1d7334d`) | **Found and fixed a further defect** | Node `01M740PRHAQY66M4G87PK1PCDA`: <ul><li>00:39:19 cut in `ingress`.</li><li>00:39:49 tunnel done; cut before the mark.</li><li>00:40:16 the marked create ran about 35 s and created exactly one VM.</li><li>Recovery attempts at 00:41:19 and 00:41:50 were cut by the 5 s deadline inside the read-only recovery, before the identity write, so no progress persisted.</li><li>Fixed in `b98b460ed`: recovery is not cut by the deadline, and the identity is recorded before the deadline is honoured.</li></ul> |


## Spend tracking

| Run | Provider | VMs x minutes | Est. cost |
| --- | -------- | ------------- | --------- |
| S1-S4, S5, S7, S8 (e2-medium, ~$0.037/h) | GCP | S2 ~2.5 h and S3 ~2 h (identity-less VMs awaiting manual delete), S4 ~35 min, S8 ~12 min, plus the S8 rerun | < $0.40 |
| S6/S9, S10 (cx23, ~€0.009/h) | Hetzner | ~15 min + ~10 min | < $0.01 |
| Tunnel and DNS API calls, Worker requests | Cloudflare | about 10 tunnels | ~$0 (included) |
| **Total** | | | **< $0.50**: well under the $20 Hetzner+CF cap and the GCP budget |

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
