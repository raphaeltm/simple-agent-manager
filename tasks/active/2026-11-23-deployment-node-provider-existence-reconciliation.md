# Release deployment nodes whose VM was deleted at the provider outside SAM

Idea: 01M81Z9P6QFX4M9Q83K2XKGZVR. Follows [#2976](https://github.com/raphaeltm/simple-agent-manager/pull/2976).
SAM task 01M82ZHHK2JG0PPJZWAYHA3XPF; coordinator 01M7XCE59V5X0WTNF1X3NFZP5J.

## Problem

A deployment VM deleted at its provider behind SAM's back (provider console, provider-side
expiry) keeps a `running` node row. #2976 deletes app-route A records only when SAM releases a
node, and its DNS sweep judges liveness from node status, so those records keep pointing at a
released IP the provider can reassign: subdomain takeover on hosted SAM and self-host installs.
No reconciler moved a running deployment node out of `running`.

## Research findings

- Generic node reconcilers filter to workspace nodes (`scheduled/node-cleanup/*`,
  `node_role = 'workspace'`). `runDeploymentNodeCleanup` claims only nodes already being torn down.
  `runProviderOrphanReconciliation` is the reverse direction (VM with no row) and lists servers;
  listing cannot prove an exact instance absent.
- `resolveStrictNodeTeardownAuthority` already distinguishes the pinned placement credential
  (exact encrypted generation) from current-owner credentials, and `proveNodeInstanceOwnership`
  documents that a not-found through a non-pinned credential is not absence proof.
- Every provider `getVM` returns null only for its API's not-found and throws otherwise
  (verified: Hetzner, Scaleway, DigitalOcean, Vultr, UpCloud, Infomaniak, GCP).
- `cleanupDeploymentNode` -> `deleteNodeResourcesStrict` is the release choke point; since #2976
  it deletes app-route records, and `deleteVM` is idempotent on an already-gone VM. It requires
  every environment on the node to be `stopping`.
- `node_lifecycle_decisions` is the aggregable verdict log (no CHECK on source/decision).
- Runtime tunables go in the admin settings registry (rule 07), following #2976's
  `admin-settings-app-route-dns-definitions.ts`.

## Implementation checklist

- [x] Migration 0267 + schema: `provider_existence_checked_at`, `provider_absence_observed_at`,
      `provider_absence_instance_id` on `nodes` (additive, nullable)
- [x] Admin settings `deploymentNodeExistence.*` (enabled, intervals, budget, probe cap, timeout)
- [x] Probe through the pinned credential only; every failure class is inconclusive
- [x] Two not-found verdicts a confirmation interval apart, same instance; present clears it
- [x] Atomic claim (environments -> stopping, node -> destroying), fenced on incarnation,
      absence record and busy environments; then `cleanupDeploymentNode`
- [x] Verdicts recorded in `node_lifecycle_decisions` (source `provider_existence`)
- [x] Deadline + probe-cap bounded sweep, stamp before I/O, 429 halts that provider
- [x] Wired into the cron node-teardown group, out of band, isolated, before the DNS backstop
- [x] Tests on a real SQL engine with real Hetzner/GCP adapters against contract fakes
- [x] Each guard deleted once; intended test red (PR body)
- [x] Docs: app-deployments guide, admin-settings guide, self-hosting
- [ ] Staging verification
- [ ] Specialist reviews (security-auditor, cloudflare-specialist, adversarial re-verify,
      task-completion-validator)

## Acceptance criteria

- [ ] A running deployment node whose provider VM is positively absent is released within the
      stated bound, and its app-route records are deleted by the #2976 path
- [ ] 401/403/429/timeout/5xx/unpinned credential never release a node
- [ ] A present instance and a single not-found leave the node untouched
- [ ] GCP / reverse-tunnel box node behaves the same
