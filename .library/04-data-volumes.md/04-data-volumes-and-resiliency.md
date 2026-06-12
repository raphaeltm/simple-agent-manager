# 04 — Data, Volumes, and Resiliency

**Last updated:** 2026-06-10

## The resiliency model

This is a single-node system by design. The resiliency primitive is therefore NOT high availability — it is:

> **The node is rebuildable; the data is detachable.**

If (a) the environment's desired state fully describes the node (releases digest-pinned in a registry, manifest + routes + secrets in the control plane) and (b) all persistent data lives on a detachable volume, then upscaling, OS rot, broken agents, provider maintenance, and most incidents collapse into ONE well-tested operation: **node replacement**. That single operation is the whole resiliency story, and it's achievable without any clustering.

## One-way door: volume placement

**Decision: persistent data lives on an attached provider block volume (e.g., Hetzner Volume), never on the node's root disk.**

The first draft of the plan put named volumes at `/srv/sam/environments/{id}/volumes/` on the root disk. Rejected because:

- Node replacement would equal data loss → forecloses the entire resiliency model above.
- Retrofitting means writing data-migration tooling for every existing environment; doing it from day one is just "mount a volume and point the path at it."

Layout:

```text
Provider volume (per environment), attached and mounted at:
  /mnt/sam-env-{environmentId}/
    volumes/{volumeName}/   <- Docker named volumes (local driver, bound under this root)
```

- Docker named volumes only, mapped into the controlled root via explicit volume definitions in the server-rendered Compose. No host bind mounts in user manifests, ever.
- Volume root path comes from environment config, not hardcoded.
- Filesystem: ext4, formatted at environment creation, `nofail` in fstab so a missing volume degrades to a reportable state instead of blocking boot.
- The deployment agent refuses to apply a release if the data volume is not mounted (fail fast, report drift) — never silently falls back to root disk.

## Provider capabilities (verify at build time; recorded 2026-06-10)

- **Hetzner Volumes:** network-attached block storage, attach/detach between servers in the same location, resizable upward online (filesystem grow is manual/agent-driven). This is the primary mechanism.
- **Hetzner server rescale:** CPU/RAM-only rescale preserves the disk and is reversible; rescale that grows the disk is irreversible (can never downscale again). Either way requires server shutdown. With detachable data volumes, in-place rescale becomes an optimization, not a necessity — node replacement covers the same need.
- **Constraint:** volume and server must be in the same location. Environment placement must record location and the replacement flow must respect it.
- **Performance constraint (set expectations):** Hetzner Volumes are network-attached storage — noticeably slower than the server's local NVMe root disk, especially for random I/O. For the target workloads (small apps, modest databases) this is acceptable, but it must be documented user-facing ("data volumes trade peak I/O for detachability"), and it is another reason heavy-I/O production databases are out of scope (below).
- **Size/count constraints:** minimum volume size 10 GB; volumes resize online only upward; a server has a provider-side attach limit (Hetzner: 16 volumes). With one data volume per environment and one environment per node (MVP), the attach limit is irrelevant — but the provider abstraction should still surface it.
- **Encryption at rest:** provider block volumes are not transparently encrypted by default. MVP posture: document this honestly (same trust level as the node's root disk — anyone with provider-account access can read it); a LUKS layer is a deferred design slot, not an MVP feature, because key management on an unattended-rebooting node is its own project.
- Scaleway (second provider) has an equivalent block-storage product; the provider abstraction in `packages/providers` should expose volume create/attach/detach/resize as first-class operations.

## Node replacement procedure (slice 3 deliverable)

```text
1. Provision replacement app node (same location, target size) from environment desired state
2. Wait for agent healthy + self-checks
3. Announce maintenance; stop app containers on old node (data-consistent stop)
4. Unmount + detach data volume from old node
5. Attach + mount data volume on new node
6. Deployment agent applies current release (images re-pulled by digest from registry)
7. Health checks pass -> repoint environment route to new node
8. Grace period -> destroy old node
```

Properties to enforce:

- **Downtime is bounded and announced** (steps 3–7); acceptable for the target workloads. Zero-downtime replacement is a non-goal.
- **Abortable before step 8** with a documented rollback (reattach to old node).
- The same flow IS the upscale flow (pick a bigger server type at step 1), the OS-refresh flow (fresh image at step 1), and the broken-agent recovery flow.
- Route repointing (step 7) is why environment-scoped URLs are mandatory (doc 05).
- Releases must be digest-pinned in a registry the new node can pull from — node-local images are not durable state. (If the registry image was deleted, replacement fails; this is drift the reconciler must surface — doc 02 slice 3.)

## What "rollback" means (and doesn't)

"Redeploy previous release" = container images and config revert. **Data does not roll back.** A release that ran a destructive DB migration is not undone by redeploying the previous image. Document this prominently in the user-facing UI, not just internal docs.

## Backups (deferred, but keep the slot)

- MVP: none beyond what the provider offers manually. Do not promise durability beyond the single volume.
- Deferred design slot: scheduled volume snapshots (provider-level) and/or restic-style file-level backup to R2/object storage, per-volume retention policy, restore-into-new-environment flow.
- Position (from the source idea, reaffirmed): SAM does not become a database operations product. Users needing PITR/HA databases should use managed database providers. Compose-hosted databases are "ordinary containers with persistent volumes," nothing more.

## Disk sizing and growth

- Root disk: OS + Docker images + logs. Sized by node type; protected by image GC and log rotation (doc 08).
- Data volume: sized at environment creation, user-visible usage metric in heartbeat, online grow supported (provider resize + filesystem grow as a maintenance action). Shrink is not supported (provider constraint) — document it.
