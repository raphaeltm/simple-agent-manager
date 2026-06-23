# 10 — Release Apply Semantics (Command Channel, Serialization, Failure Behavior)

**Last updated:** 2026-06-10
**Added in:** third adversarial pass. Earlier docs said "signed apply command to the deployment agent" without specifying how commands travel, what happens when two arrive at once, or what the node does when an apply fails. Those gaps are decided (or explicitly leaned) here.

## 1. Command delivery channel: pull, not push

**Decision (leaning, confirm in slice 1 spike): the agent pulls work; the control plane never opens inbound connections to apply releases.**

Mechanics:

- The agent's existing heartbeat (or a long-poll variant of it) carries a `pendingReleaseSeq` field in the response. When the node's applied sequence < pending sequence, the agent fetches the full signed apply payload from a control-plane endpoint (callback-JWT auth, per rule 34).
- Push (API → node HTTPS) is how the workspace pattern works today, and it remains available for low-latency actions (restart service, stream logs). But the *authoritative* deploy path must work pull-only, because:
  - It survives node IP changes, firewall tightening, and a future move to Cloudflare Tunnel (doc 09 Q4) without redesign.
  - A node that was offline (reboot, network blip) catches up on reconnect by construction — the same code path as drift reconciliation. Push requires a separate retry/queue design to get the same property.
  - It keeps the node's inbound surface limited to app traffic (doc 03 firewall posture).
- Latency expectation: heartbeat interval (~15–30s) is an acceptable worst-case deploy start latency for this product. If it ever isn't, add a "poke" push that just means "heartbeat now" — the poke carries no authority.

## 2. Signing and key management

The apply payload is signed so the node does not have to trust transport alone (defense in depth; doc 06 validation layering already requires node-side re-validation).

- **Signer:** the SAM API, with a dedicated deploy-signing key — NOT the callback-JWT key. Different audience, different rotation cadence, different blast radius.
- **Key storage:** Worker secret (same operational pattern as JWT keys). Public key delivered to the node at provision time AND refreshable via heartbeat response (so rotation does not require node replacement).
- **Rotation:** dual-key window — node accepts signatures from current + previous key during rotation. Heartbeat response advertises the active key set.
- **Payload binding (restating doc 07 with the channel decided):** environment ID, node ID, release sequence number, expiry. The node rejects: wrong environment, wrong node, sequence ≤ last applied (replay), expired payload.
- The **monotonic release sequence** doubles as the replay protection and the concurrency primitive (§3). Sequence is allocated by the control plane at release authorization time, per environment.

## 3. Concurrency: one apply at a time, per environment

Two agents (or a human + an agent) can plausibly trigger deploys seconds apart from slice 2 onward — and certainly in slice 4.

- **Control-plane serialization is authoritative.** Release creation for an environment is serialized at the source (D1 transaction allocating the next sequence; or an environment-scoped DO if contention ever warrants it). There is never more than one `pending` release per environment: a new release request while one is pending either **supersedes** it (if not yet picked up by the node — the pending release is marked `superseded` and the new one takes its sequence slot order) or **queues** behind it (if the node is mid-apply).
- **Node-side mutex as backstop.** The agent applies one release at a time, ever; a second payload arriving mid-apply is rejected with "apply in progress" and retried by the normal pull cycle.
- **No cancellation of an in-flight apply in v1.** The unit of cancellation is "wait for it to finish, then deploy the next release." Killing a half-applied release creates exactly the partial states the restart-safe design works to avoid.

## 4. Failed deploy: converge backward, loudly

What the node does when an apply fails (image pull error, container won't start, health check never passes):

**Decision: revert to the last successfully applied release, mark the failed release `failed`, surface prominently. No retry loops on the same release.**

- The release directory layout (doc 03) makes this cheap: the previous release's rendered Compose and images (retained by rollback-aware GC, doc 08) are still on disk. Revert = re-apply the previous "current" pointer.
- **Why not "leave the new release half-up and report"?** A half-applied multi-service release is the worst possible state: partially new, partially old, possibly schema-mismatched. The user can't reason about it and neither can the reconciler.
- **Why not auto-retry?** Failures here are almost never transient (bad image, bad config, failing health check). Retry loops burn time and hide the failure. The user (or agent) fixes the manifest and deploys a new release — which is the retry.
- **The data caveat (doc 04 restated):** revert restores *containers*, not data. If the failed release ran a destructive migration before failing health checks, reverting the containers does not undo it. This is inherent and must be documented at the rollback UI surface. Mitigation is §5, not magic.
- Edge case: **first release of an environment has nothing to revert to.** Failed first apply = environment in `failed-initial` state, all containers stopped. Clear error, no ambiguity.
- The failed release's apply log is retained on the release record (doc 08 observability) — the agent streams apply output as it goes, so a failure mid-apply still has its evidence.

## 5. Release hooks and database migrations (the missing manifest concept)

Real apps need "run this command once per release" (DB migrations, asset compilation). Without a first-class hook, users will smuggle migrations into container entrypoints — which makes every restart a migration run and makes failed deploys (§4) actively dangerous.

**Decision: a single optional pre-flight hook per release, in the manifest, from slice 3.** (Slice 2's single-service environments can survive on entrypoint-managed migrations; document the sharp edge.)

Manifest addition (extends doc 06 sketch):

```jsonc
"hooks": {
  "preFlight": {
    "service": "web",                  // run in this service's image
    "command": ["./manage.py", "migrate"],
    "timeoutSeconds": 300              // capped by SAM
  }
}
```

For API submissions, agents author this manifest through Compose YAML using SAM extensions. The equivalent Compose hook field is `x-sam-pre-flight`, while routes use top-level `x-sam-routes` and secret references use environment values shaped as `{ x-sam-secret: "<secret-name>" }`. The release API stores the validated, digest-pinned manifest JSON after parsing and resolving the Compose file.

Semantics:

- Runs as a one-shot container (same image, env, network, and volumes as the named service) **after** images are pulled and the previous release's containers are stopped, **before** new containers start. Sequence: pull → stop old → hook → start new → health check.
- Hook failure = release failure → §4 revert path (with the data caveat: the hook may have partially run; that is exactly why it must be the user's idempotent migration tool, and why the docs say "migrations must be forward-safe").
- Hook stdout/stderr is part of the release apply log.
- Exactly one hook in v1. No post-deploy hooks, no per-service hooks, no cron — those are scope creep with workarounds (the app can do them itself).

## 6. Observed-state reporting (closing the loop)

Each heartbeat carries: applied release sequence + status (`applied | applying | failed | reverted`), per-service container state + health, disk/volume usage (doc 08), agent version (doc 03). The control plane derives environment status purely from desired state (D1) vs this observed report — there is no third source of truth.
