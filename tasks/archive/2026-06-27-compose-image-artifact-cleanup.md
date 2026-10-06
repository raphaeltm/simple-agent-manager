# Compose Image Artifact Cleanup

## Problem

R2-backed app deployment image artifacts under `compose-image-artifacts/` can accumulate when a build uploads Docker archives but the release is never recorded or no longer references those uploaded objects. Staging evidence on 2026-06-27 showed four compose image artifact objects in `sam-staging-assets`, with only one referenced by `deployment_releases.manifest`; the other three accounted for about 614 MB of apparently abandoned data.

This task is intentionally scoped only to deployment compose image artifacts from the build/deploy system. It must not clean up `temp-uploads/`, `library/`, `agents/`, `cli/`, `tts/`, or other R2 prefixes.

## Safety Invariant

Never delete an artifact that is live, active, reschedulable onto another VM, or promotable between environments. The first implementation should be conservative: any object key referenced by any persisted deployment release manifest is protected, regardless of age or release status. Cleanup may delete only unreferenced objects under `compose-image-artifacts/` after a configurable grace period.

If the cleanup job cannot confidently compute the referenced-artifact set, it must fail closed and delete nothing.

## Research Findings

- Compose image artifact upload keys are built in `apps/api/src/services/compose-image-artifacts.ts` as `compose-image-artifacts/{projectId}/{environmentId}/{workspaceId}/{uploadId}/{service}.docker-save.tar`.
- Compose-publish release submission stores service artifact descriptors in `deployment_releases.manifest` through `apps/api/src/routes/projects/compose-publish-release-callback.ts`.
- Deployment apply transforms release manifests and mints short-lived R2 download URLs from referenced artifact descriptors in `apps/api/src/routes/deploy-release-callback.ts`.
- The existing scheduled Worker sweep in `apps/api/src/index.ts` already coordinates recurring cleanup jobs and logs summary counters.
- Existing task cleanup patterns use env-configurable kill switches, retention windows, and batch limits.
- A simple R2 lifecycle rule is not sufficient for this prefix because release reachability and future promotion/reschedule behavior are product semantics, not object age semantics.

## Implementation Checklist

- [x] Add configurable env vars for compose image artifact cleanup: kill switch, abandoned-object grace period, batch size, and run interval.
- [x] Implement a scheduled cleanup service that lists only `compose-image-artifacts/` objects.
- [x] Compute a protected artifact key set from persisted deployment release manifests across all environments/projects.
- [x] Fail closed and delete nothing if any relevant release manifest cannot be parsed safely.
- [x] Delete only unreferenced compose artifact objects older than the configured grace period, bounded by batch size.
- [x] Gate execution from the existing cron path so the expensive R2 list/delete pass runs at most once per configured interval.
- [x] Add unit tests for protected referenced artifacts, abandoned old artifacts, young unreferenced artifacts, malformed manifest fail-closed behavior, batch limits, kill switch, and interval gating.
- [x] Update env examples and operational logging summaries for the new cleanup counters.
- [x] Run focused tests and quality gates.

## `/do` Phase Gates

Specialist review and staging verification are tracked in `.do-state.md` and the PR evidence, outside the implementation checklist.

## Acceptance Criteria

- Objects outside `compose-image-artifacts/` are not listed or deleted by this cleanup path.
- Any `compose-image-artifacts/` object referenced by any persisted deployment release manifest is retained.
- Unreferenced compose image artifacts older than the configured grace period are deleted in bounded batches.
- Cleanup fails closed when release-manifest reachability cannot be computed.
- The scheduled job is configurable, observable, and does not run a full R2 scan every five minutes by default.
- Tests cover the retention and deletion safety boundaries.

## References

- SAM idea `01KW463HFYM2706C7K6EJ6R6GP`: Compose image artifact retention and cleanup policy.
- User clarification on 2026-06-27: scope cleanup only to compose image artifacts from the build/deploy system; keep live/reschedulable/promotable artifacts safe; manage lifecycle in SAM rather than R2 age-only lifecycle rules.
