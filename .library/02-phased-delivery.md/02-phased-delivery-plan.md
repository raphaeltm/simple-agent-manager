# 02 — Phased Delivery Plan

**Last updated:** 2026-06-10
**Status:** Revised after adversarial review. The first draft sequenced for demo value and front-loaded three one-way-door shortcuts (root-disk volumes, workspace-proxy URLs, no agent restart-safety). This version sequences so that decisions that are cheap now and expensive to retrofit are made in slices 1–2.

Each slice is independently shippable and user-valuable. Slice 1 is the largest, not the smallest — see "honest sizing" notes.

---

## Slice 1 — App node lifecycle

**Ship:** a user can provision a node with `node_role: deployment` that runs a restart-safe deployment agent, survives reboots and OS updates, and is exempt from all ephemeral-node reapers.

### Contents

- `node_role: workspace | deployment` column (additive migration; default `workspace`).
- Deployment agent = existing vm-agent binary with `--role=deployment` (leaning; see doc 09 Q1). Reuses heartbeats, TLS bootstrap, debug-package, R2 binary distribution. Exposes ONLY: health, status, logs, apply-release (stub), reconcile. **No workspace-management endpoints.**
- **Restart-safe agent design** (the core constraint): desired state persisted on disk, systemd `Restart=always`, startup = reconcile against desired state. The agent must tolerate being killed at any moment (daemon-reexec, OOM, update) without affecting running containers. See doc 03.
- **Agent self-update channel** (or strictly versioned agent↔API contract). Long-lived nodes cannot run boot-time binaries forever. See doc 03.
- **OS update posture for app nodes:** security patches ON, Docker engine held back, `live-restore: true`, no auto-reboot, reboot-required surfaced. Diverges from the workspace-node cloud-init template. See doc 03.
- **Reaper/scheduler exemption audit:** NodeLifecycle DO warm-pool alarms, cron sweep, max node lifetime, and workspace scheduler must all exclude `node_role = 'deployment'`. Audit every query that implicitly assumes all nodes are workspace nodes (same bug class as rule 40 sentinel rows). See doc 08.
- UI: "App Node" creation option, distinct badge, excluded from workspace placement.

### Honest sizing

This is not "add a role flag." It is a second node lifecycle (pets) next to the existing one (cattle). Budget accordingly.

### Standalone value

"SAM manages a VM for me with heartbeats, logs, debug packages, and safe OS updates" — useful even before deploys exist, and it forces the trust-boundary and lifecycle plumbing early, where the architecture risk lives.

---

## Slice 2 — One real app, durably (agent-first)

**Ship:** an agent in a workspace builds an image, pushes it to the SAM-hosted registry, and deploys it to a user-defined environment — with secrets, persistent data on a detachable volume, and a stable environment URL.

**Revised 2026-06-10:** the first version of this slice was human-UI-first with images supplied by the user's own CI ("BYO CI"). Rejected by Raphaël: no GitHub dependency beyond repo hosting, stay within Cloudflare, and agents — not a UI form — are SAM's primary interface. The provenance gap is dissolved, not patched: **agents build images in their workspaces** (Docker is already available there) and push to a registry SAM owns.

### Contents

- `deployment_environments` (D1): one environment → one node, one service, one HTTP route. Environment owns the node reference, not vice versa.
- **Normalized deployment manifest schema defined now**, constrained to a single service. NOT an ad-hoc `{imageDigest, port}` API — slice 3 must extend the manifest, not replace the contract.
- SAM renders the Compose file server-side from the manifest; signed apply command to the deployment agent. No Compose parsing yet (deferred to slice 3 — users supply manifest fields via UI form).
- **Data on an attached provider volume** (Hetzner Volume), mounted at the volume root. Named Docker volumes map under it. One-way door: do NOT put data on the root disk. See doc 04.
- **Environment-scoped route**: `{env}--{project}.<BASE_DOMAIN>` (exact scheme TBD, doc 05), repointable to whichever node backs the environment. Public/private mode explicit. Do NOT reuse `ws-*` workspace proxy URLs.
- **Server-side secret injection**: environment-level secrets, encrypted at rest (reuse per-user credential encryption pattern), injected at compose-render/apply time, never readable via UI or agent surface. Minimal CRUD UI (set/delete, no read-back). Deferring secrets entirely was rejected — almost no real app runs without at least one secret.
- **Cloudflare managed container registry** (`registry.cloudflare.com`) — the same registry SAM already uses for the devcontainer build cache — fronted by a **SAM registry proxy** (Worker, registry v2 protocol) that accepts project-scoped SAM tokens, enforces the repository-path prefix per project, and swaps in the upstream CF credential server-side (devcontainer-cache minting pattern). Agents and app nodes only ever hold SAM-scoped tokens. Spike: Workers body limit vs layer push size, upload-session `Location` rewriting — doc 09 Q3.
- **Agent deploy tools (the primary interface):** `get_registry_credentials(environment)` → scoped push token; `submit_deployment(environment, manifest)` → SAM validates (digest must exist in the project namespace), renders, signs, applies; `get_deployment_status/logs(environment)` read-only. The agent never touches the node — it pushes bytes to the registry and *proposes* a manifest. Trust boundary unchanged.
- **Coarse policy gate only** (full capability matrix stays slice 4): per-environment toggle "agents may deploy here", token scoped to the project's registry namespace, manifest digests must resolve within that namespace. This is the floor below which agent deploys are unsafe; everything finer waits.
- UI shrinks to the human-owned parts: environment creation (size, location, secrets, agent-deploy toggle), deploy status + container logs. External images (public or user pull credential) remain supported as a secondary path.
- Apply semantics (pull-based command channel, signing, per-environment serialization, failed-deploy revert) per doc 10.

### Standalone value

"Host a container on your own VM from SAM, with a stable URL and persistent data." Real apps, not demos.

---

## Slice 3 — Releases, multi-service, promotion, day-2 operations

**Ship:** multi-service apps from a Compose file, release history with rollback, **deterministic environment promotion**, and the operations that keep a node alive in month 3 — including node replacement.

### Contents

- Compose-subset parser → normalized manifest, with the denylist from doc 06. Reject `build:`, privileged, host mounts, host networking, etc. Agents can now hand SAM a Compose file directly instead of manifest fields.
- Multi-service manifests; multiple named volumes; the single pre-flight release hook for migrations (doc 10 §5).
- `deployment_releases` (D1): immutable release records with full audit context; release directories on the node; "redeploy previous release" (images only — never data).
- **Release promotion (deterministic, agent-free):** `promote_release(fromEnv, toEnv)` — take the source environment's release (exact image digests + manifest structure), re-render with the **target** environment's secrets, routes, and config, and apply. No agent involved, no rebuild, no re-push: promotion is a pure control-plane operation over already-validated digests. Optional human approval per target environment (production defaults to require-approval). This is the "staging looked good — run the same stack in production" flow Raphaël described, and it is the reason the manifest stores digests, not tags: promotion is byte-identical by construction.
- Reconciliation hardening: agent reports observed state in heartbeats; SAM compares against desired release and surfaces drift in the UI (detect and display; auto-heal only for the safe cases like reconverge-on-boot).
- **Day-2 operations** (doc 08): image GC respecting rollback retention (keep last N release image sets), container log rotation via daemon.json, disk usage in heartbeat + alert thresholds before disk-full.
- **Node replacement operation** (the resiliency proof, doc 04): provision replacement node from environment desired state → stop app → detach data volume → reattach → reconcile → repoint route → destroy old node. Also covers upscale (replace with bigger node) without data loss.

### Standalone value

"Run a real multi-container app with rollback, and survive node upgrades/replacement."

---

## Slice 4 — Fine-grained deploy policy and governance

**Ship:** the full capability matrix governing what agents may do per environment — upgrading slice 2's coarse "agents may deploy here" toggle into explicit, auditable policy.

**Revised 2026-06-10:** the original slice 4 ("agent-triggered deploys as an MCP tool") moved to slice 2 — agent deploys ARE the primary interface, not a late add-on. What remains here is governance depth.

### Contents

- Capability-based deploy policy per environment (doc 07): allowed profiles, allowed secret names, route/volume change rights, rollback rights, promotion rights (who may promote INTO this environment), approval requirement. Per-environment tiers like Raphaël's sketch: agents get full build/deploy/logs on staging, read-only or promote-with-approval on production.
- Human approval gate reusing existing `request_human_input` / approval patterns; pending-approval state in `deployment_releases`.
- Full audit context on every release: actor, profile, task/session ID, source repo/ref/SHA, image digests, referenced secret names, approval record, policy decision ID. (Slice 2/3 already record the basics; this hardens it into a complete policy-decision trail.)
- Registry hardening: repository naming conventions per project, retention/GC of unreferenced digests (within what the Cloudflare managed registry supports — doc 09 Q3), optional external-registry allowlist policy.
- Possibly later (explicitly not committed): SAM-managed build system so deploys don't require an agent workspace at all.

### Standalone value

Production-grade governance: agents build software AND ship it, with per-environment guardrails the user controls.

---

## Sequencing rationale

- **Riskiest unknowns first:** node-role lifecycle separation and the no-SSH restart-safe apply path (slices 1–2) are where the architecture could be wrong. Compose parsing (slice 3) is careful but predictable work.
- **One-way doors decided early, cheaply:** data volume placement, environment-scoped URLs, manifest-shaped API contract, restart-safe agent design. Each is nearly free in slices 1–2 and brutally expensive to retrofit.
- **Agent-first from slice 2:** agents are SAM's primary interface; the registry and agent deploy tools cannot wait for slice 4 without shipping a UI-shaped product first and retrofitting the real one later.
- **Deferred safely:** custom domains, zero-downtime deploys, backups/snapshots, fine-grained policy/approval workflows, SAM-managed builds — none forecloses anything by waiting.

## Per-slice gate (applies to all)

Each slice must pass the repo's standard gates (staging verification with real VM provisioning per rule 02 "Infrastructure Change Verification", capability tests per rule 10, vertical slice tests per rule 35). Slice 1 and 3 in particular touch `packages/cloud-init`/vm-agent and REQUIRE real VM provisioning verification on staging — and note rule 27: testing vm-agent changes requires deleting existing staging nodes first.
