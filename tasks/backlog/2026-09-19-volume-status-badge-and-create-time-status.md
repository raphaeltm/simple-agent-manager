# Volume status presentation and create-time provider snapshot

**Status:** backlog
**Discovered:** 2026-09-19, during local specialist review of the app-deployment fix port
(`tasks/archive/2026-09-19-port-app-deployment-fixes-and-dedupe-pending-release.md`). Both items
are adjacent to that change but deliberately out of its scope.

## Problem

### 1. `StatusBadge` has no entry for any `VolumeStatus`

`packages/ui/src/components/StatusBadge.tsx`'s `statusConfig` map covers workspace/node/task/
trigger statuses but none of the provider `VolumeStatus` members
(`packages/providers/src/types.ts`: `creating | available | attaching | attached | detaching |
resizing | deleting | unknown`). `apps/web/src/components/deployments/DeploymentVolumesPanel.tsx`
renders `<StatusBadge status={volume.status} label={volume.status} />`, so the explicit `label`
keeps the text correct while the colour falls through to the neutral "unknown" palette.

`creating` is the one accidental match — it collides with the workspace status of the same name —
so before the attach fix an attached volume showed the wrong label in a confident info-blue. It
now shows the right label in neutral grey: more accurate, still not styled. Add proper entries so
`attached`/`available` read as success/neutral and `creating`/`attaching`/`detaching`/`resizing`
read as in-progress.

This is cosmetic only. Nothing gates on `deployment_volumes.status` — the heartbeat readiness
check keys on `attached_server_id` (`apps/api/src/routes/node-lifecycle.ts:94-129`).

### 2. `createEnvironmentVolume` persists the provider's create-time snapshot

`apps/api/src/services/deployment-volumes.ts:254` writes `status: volumeResult.status` straight
from `provider.createVolume()`. That is the same "persist a transient remote snapshot that nothing
re-polls" class as the attach-path bug fixed on 2026-09-19 — Hetzner commonly reports `creating`
at that instant and the row is only rewritten by attach or detach. It is not currently a live
incident, because a created volume is attached shortly afterwards and the attach path now writes a
settled `attached`. It becomes one for any volume that is created and never attached.

## Acceptance criteria

- [ ] `StatusBadge`'s `statusConfig` covers every `VolumeStatus` member, with in-progress states
      visually distinct from settled ones
- [ ] `DeploymentVolumesPanel` renders each state with the intended palette; Playwright visual
      audit at 375px and 1280px per `apps/web/.claude/rules/17-ui-visual-testing.md`, since this
      touches `packages/ui/` and `apps/web/`
- [ ] `createEnvironmentVolume` persists a settled SAM-side status, or documents in a comment why
      the provider snapshot is authoritative on the create path
- [ ] A regression test asserting a transient provider status is not persisted at create time

## References

- `apps/api/.claude/rules/57-write-only-cross-boundary-state.md` — remote-owned state must be
  reconciled, not just reported
- `apps/api/.claude/rules/75-external-api-check-then-act.md` — the sibling-asymmetry requirement
  that surfaced item 2
- `packages/ui/.claude/rules/17-ui-visual-testing.md`
