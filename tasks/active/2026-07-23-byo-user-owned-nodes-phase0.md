# BYO / User-Owned Nodes — Phase 0 (safety substrate + security prerequisites)

**Date:** 2026-07-23
**Idea:** `01KY7M8N1RBC4ZV6ZKSNG878B3` (full file-by-file plan)
**Library:** `/engineering/byo-nodes/` (research 01-05, critique-architecture, critique-security, plan-v2-final, spike-report)
**Output branch:** `sam/build-byo-user-owned-e2d62t`

## Problem & Motivation

Hetzner is raising prices. Let a user register an existing machine they own (home server,
Mac Mini, office box, GPU workstation) as a SAM runner so neither SAM nor the user pays
cloud compute for that work. Model a BYO machine as a **node attribute (`nodeClass`), never a
`Provider`** — `cf-container` already proves the provider-less node shape.

This task ships **Phase 0 only**: the safety substrate + the three pre-existing security fixes
that self-service enrollment would weaponize. Phase 0 is **independently shippable, no
user-visible change**, and de-risks every later phase. Phase 1+ (tunnel transport, enrollment
endpoint, vm-agent host mode, CLI, UI) is deferred to follow-up PRs.

## Constraints (from dispatch + policies)

- **NO STAGING** — explicit human instruction + policy. Substitute = local tests + CI + bounded
  experiments (spike-report). State the skip in the PR.
- **Merge authorized via /do** only when CI green + all local reviewers PASS. Hold
  `needs-human-review` if any CRITICAL/HIGH security finding is unresolved, CI is red, or the
  experiments disprove the tunnel transport.
- PR 0B touches SHARED auth → MANDATORY security-auditor review (rules 25, 28).
- Additive migration only (rule 31 — `quality:migration-safety`).
- vm-agent binary changes (Phase 1C, deferred) get full runtime verification only on fresh
  nodes post-deploy (rule 27).

## Experiments (gate the DEFERRED Phase 1 transport; run + document in spike-report.md)

- **E1** — Worker `fetch("https://<host>.vm.<domain>:8443")` reaches a cloudflared tunnel origin?
  (:8443 vs :443 vs per-node port override). Blocked from full edge proof by DNS-read-only CF
  token → partial local proof + CF docs + recommend adding Tunnel-edit perm + real staging spike.
- **E2** — WebSocket upgrade + >30s idle + streamed bodies survive the tunnel. Proven locally via
  cloudflared quick-tunnel (trycloudflare) — non-destructive, touches no SAM infra.
- **E3** — vm-agent host mode: plain-HTTP on 127.0.0.1 behind cloudflared; refuse to start if not
  loopback. Local Go experiment + config.go analysis.
- **E4** — per-account named-tunnel limits (CF API count + docs).

## Research findings (code-verified anchors; VERIFY before editing)

### Security (critique-security.md — 8 findings)

1. **[CRITICAL] Callback-token binding.** `agent-activity-callback.ts:80` authorizes on client-supplied
   `body.nodeId`, never binds `payload.workspace`. `node-acp-heartbeat.ts:47-52` explicitly skips the
   cross-check. Correct pattern: `node-callback-auth.ts:27` (`payload.workspace !== nodeId`),
   `workspaces/_helpers.ts:99-138`. Self-service enrollment hands every user a valid node JWT →
   cross-tenant session forgery becomes a click. → **PR 0B**
2. **[CRITICAL] Origin CA wildcard issuance not ownership-gated.** `node-lifecycle.ts:218-244` →
   `origin-ca-certificates.ts` issues `*.{BASE_DOMAIN}` to any node with a valid callback token; no
   node-row load. A BYO owner can `curl` a platform-wide wildcard cert+key. → **PR 0B** (deny for
   `nodeClass='user-owned'`, server-side).
3. **[HIGH] Loopback bind enforcement** — Phase 1C (deferred).
4. **[HIGH] Revocation-on-refresh.** `jwt.ts:456-475` (`shouldRefreshCallbackToken`) +
   `node-callback-auth.ts` do no node-row lookup → a de-enrolled node keeps auto-renewing. → **PR 0B**
   (check `node.status` before minting refreshed token). Full secret-exchange subsystem deferred to Phase 3.
5. **[MEDIUM] Tunnel-token lifecycle** — Phase 1A (deferred).
6. **[MEDIUM] Non-root host exec + consent** — Phase 1C/1D (deferred).
7. **[MEDIUM/regression] userId-scoped scheduling** currently correct (`node-selector.ts:117,199-201`,
   `node-steps.ts:40-44`) but unpinned. → **PR 0B** regression test: forked task with
   `credentialAttributionUserId ≠ userId` never selects a node owned by anyone but `userId`.
8. **[LOW] Heartbeat DNS/IP backfill** unconditional at `node-lifecycle.ts:286-353`. → **PR 0C** gate on
   `transport==='cloudflare-tunnel'`/`tunnelId` presence (server-side).

### Architecture (critique-architecture.md — Phase-0-relevant)

- Centralize lifecycle guards in 3 chokepoints (`markIdle`, `stopNodeResources`, `deleteNodeResources`)
  - cron queries, NOT ~8 caller sites. `stopNodeResources` reachable from Stop button + markIdle
    failure fallback (`task-runner.ts:230-234`). → **PR 0C**
- `credentialSource` sentinel picked in Phase 0 (`'self-hosted'`) so metering/quota/cost exclude BYO
  by construction; admin cost exclusion must live inside `node-usage.ts`. → **PR 0A + 0C**
- `MAX_NODES_PER_USER` counts BYO at `nodes.ts:216-229` + `node-steps.ts:202-210`. → **PR 0C**
- Zombie-sweep tests need synthetic user-owned rows (Phase 0 exclusions are dead code until Phase 1). → **PR 0C**

## Implementation checklist

### PR 0A — migration + shared types (no behavior change)

- [ ] `apps/api/src/db/schema.ts` nodes: add `nodeClass` (text notNull default `'managed'`),
      `transport` (text null), `tunnelId` (text null), `tunnelName` (text null); index on `nodeClass`.
- [ ] New additive migration `apps/api/migrations/00XX_byo_nodes.sql` (4 `ADD COLUMN`).
- [ ] `packages/shared/src/types/user.ts` `CredentialSource`: add `'self-hosted'`; update consumers.
- [ ] shared node/workspace types: `NodeClass`/`NodeTransport` unions + `isNodeClass` guard; extend
      `NodeResponse` (`nodeClass`, `transport`, `tunnelName`; provider/size/location nullable in UI type).
- [ ] `apps/api/src/routes/nodes.ts` `toNodeResponse`: surface `nodeClass`/`transport`; null
      provider/size/location for user-owned.
- [ ] Tests: migration additive test; type-guard unit tests.

### PR 0B — security prerequisites (shared-auth; MANDATORY security-auditor; hold on CRITICAL/HIGH)

- [ ] `agent-activity-callback.ts`: bind token identity — node-scoped → `payload.workspace===existing.nodeId`;
      workspace-scoped → `payload.workspace===existing.workspaceId`. Keep body.nodeId check as defense-in-depth.
- [ ] `node-acp-heartbeat.ts`: node-scoped → `payload.workspace===body.nodeId`; workspace-scoped → single
      indexed lookup `workspaces.node_id === body.nodeId`. Structured reject log.
- [ ] `origin-ca-certificates.ts`/`node-lifecycle.ts`: load node row, deny wildcard issuance when
      `nodeClass==='user-owned'`, server-side.
- [ ] `jwt.ts` refresh + `node-callback-auth.ts`: check `node.status` (non-terminal) before minting
      refreshed callback token so deregistration stops the refresh cycle.
- [ ] Tests (rule 28): cross-tenant forgery rejected (node A token can't post node B); origin-CA denied
      for user-owned; refresh blocked after status flip; userId-scoped scheduling regression.

### PR 0C — lifecycle guards + billing/quota exclusion

- [ ] `task-runner.ts` markIdle (~222) + failure-fallback (~230-234): skip user-owned.
- [ ] `durable-objects/node-lifecycle.ts` (markIdle ~71, alarm ~214, D1 write ~257-259): never warm/destroy user-owned.
- [ ] `services/nodes.ts` `stopNodeResources` + `deleteNodeResources`: user-owned = never `deleteVM`, no
      destructive tunnel-CNAME delete; "stop" ⇒ offline not delete. Fix cf-container asymmetry.
- [ ] `services/strict-node-deletion.ts`: missing `providerInstanceId` = nothing-to-delete for user-owned.
- [ ] `scheduled/node-cleanup.ts`: `node_class != 'user-owned'` in EVERY destroy query
      (stale-warm ~277, max-lifetime ~371, stopped-handoff ~427, orphaned ~548-591) + zombie-sweep tests (rule 47).
- [ ] `services/node-usage.ts` + `services/compute-usage.ts` + `routes/admin-costs.ts`: exclude user-owned
      from vCPU-hour + $ (do exclusion inside `node-usage.ts`).
- [ ] `routes/nodes.ts` + `durable-objects/task-runner/node-steps.ts`: exclude user-owned from `MAX_NODES_PER_USER`.
- [ ] `routes/node-lifecycle.ts` heartbeat: skip A-record backfill when `tunnelId` present + regression test.

### Process fix (rule 02 mandatory)

- [ ] Add a `.claude/rules/` rule generalizing the class (server-side gate on node-class-sensitive
      auth/lifecycle; never trust client-supplied identity / agent abstention) + PR post-mortem section.

## Acceptance criteria

- [ ] Migration is additive; `pnpm quality:migration-safety` passes.
- [ ] Cross-tenant callback forgery is rejected by a behavioral test that FAILS on pre-fix code.
- [ ] Origin CA wildcard issuance denied for user-owned by a behavioral test.
- [ ] Callback-token refresh blocked after node status flips to terminal.
- [ ] User-owned nodes excluded from every cleanup/destroy query (two-sweep zombie test, rule 47).
- [ ] User-owned nodes excluded from vCPU-hour/cost accrual and `MAX_NODES_PER_USER`.
- [ ] Tunnel-node heartbeat writes no A record (regression test).
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.
- [ ] spike-report.md uploaded to library with E1-E4 findings.

## References

- Rules 25, 28, 31, 47, 02, 34, 40, 11, 06.
- Idea `01KY7M8N1RBC4ZV6ZKSNG878B3`; library `/engineering/byo-nodes/`.
