# Infomaniak boot volume follow-ups (from PR #2854 review)

## Problem

PR #2854 (#2842) boots Infomaniak VMs from a Nova-created Cinder volume. Local review found
pre-existing or adjacent gaps that the volume makes more likely to matter. They were deferred to keep
that PR to the root-disk fix; none blocks it.

## Context

- Reviews on PR #2854: task-completion-validator finding 9; security-auditor M1, M2, M3.
- Files: `packages/providers/src/infomaniak-metadata.ts` (`mapInfomaniakStatus`,
  `classifyInfomaniakError`), `packages/providers/src/infomaniak-boot-volume.ts`,
  `apps/api/src/routes/nodes.ts`, `apps/api/src/routes/workspaces/workspace-create.ts`.

## Items

1. **Server `ERROR` maps to `initializing`.** A boot-volume creation failure (Cinder quota, image
   download) leaves the server in `ERROR` after the create call; the node waits for the heartbeat
   timeout instead of failing fast. Pre-existing for every Nova build failure. Any fast-fail must
   keep the created server recorded so teardown still deletes it (do not throw before the node row
   has the instance id).
2. **403 quota responses are classified `auth_error`.** `classifyInfomaniakError` maps every 403 to
   `auth_error`; Nova reports instance/core quota as 403. Classify by recovery action (rule 72) and
   enumerate consumers (rule 67) before changing the arm.
3. **Explicit `bootDiskSizeGb` on platform credentials (GCP).** Fixed for Infomaniak in PR #2854:
   an explicit size above `infomaniak.bootVolumeGb` is refused before any request. GCP still honours
   explicit sizes with no upper bound on platform credentials; decide a cross-provider policy.
4. **Unlabeled boot volumes.** Base Nova `block_device_mapping_v2` cannot set volume metadata, so a
   boot volume left behind by a failed Nova delete cascade is invisible to SAM. Consider an
   operator-visible report of unattached unlabeled volumes (never an auto-delete: rule 56).

## Acceptance Criteria

- [ ] Each item fixed with a discriminating test, or explicitly rejected with a reason in this file
