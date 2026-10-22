# Deployment environments stuck in `error` cannot recover; blocked placements are silent

## Problem

Production environment `01M5HCF0X7Y2S9V74NV0AV3K99` (project `01M5HB4YTGT16MZKGYS970N792`
"oct-22-hack", environment `staging`) never recovered after one failed deploy:

1. Release v1 (`01M5HCNENG8YE2600CXNK2BCSR`, 08:47Z 2026-10-22) failed placement: Hetzner
   returned `412 error during placement` for `cx23` in `fsn1`.
   `markDeploymentReleasePlacementFailed` set the environment to `status = 'error'`.
2. Releases v2 (`01M5HD1W6MA3P5Q9ZG84NV6KN7`, 08:53Z) and v3 (`01M5HDJ9066BM8YNRZNF2FJQTP`, 09:02Z)
   never reached Hetzner. Each created a fresh deployment node row
   (`01M5HD1X1HHA7FYNPATVFP71AD`, `01M5HDJ9XJ2CCHM8W18SBC2GRR`) that ended
   `error: "[hetzner] Deployment provisioning authority is no longer current"`.
3. Both releases stayed `created` forever, and the environment page kept showing v1's Hetzner error.
   The agent gave up and created a new `dev` environment, which deployed fine on cx23/fsn1 at 09:07Z.

Raphaël: "Fix it and ship it."

## Root cause

- `assertDeploymentProvisioningAuthority` (`apps/api/src/services/provisioning-authority.ts`), the
  paid-boundary check `provisionNode` runs before and after `createVM`, requires
  `de.status = 'active'`. Nothing moves an `error` environment back to `active` before fresh
  provisioning, so the check fails for every recovery release.
- The same check also rejects `starting`, the status `startDeploymentEnvironment` sets before it
  calls `provisionDeploymentNode`. A Start that needs a fresh node fails the same way.
- `ProvisioningAuthorityError` is classified as a cancellation by `isPlacementCancellation`
  (`apps/api/src/routes/deployment-release-placement.ts`). `observeProvisioningResult` therefore
  records nothing: the release stays `created`, the environment keeps the old error.
- Even if provisioning were allowed, the node heartbeat (`apps/api/src/routes/node-lifecycle.ts`)
  only advertises environments whose status is `active` or `starting`. An `error` environment linked
  to a new node would never receive the release. `linkEnvironmentToLegacyNode` already flips
  `error` → `starting` for exactly this reason; `linkEnvironmentToNode` (pooled and fresh nodes) does
  not.
- The documented contract says this should work: `apps/www/.../guides/app-deployments.md` and the
  `get_deployment_guide` MCP text tell agents that a new release IS the recovery path for an `error`
  environment, and `AGENT_DEPLOYABLE_ENVIRONMENT_STATUSES` admits `error` for that reason.

## Research findings

- `de.status = 'active'` was added in #2030 (2026-09-08), after the error-recovery contract
  (#2120 legacy adoption) and Start (`deployment-environment-lifecycle.ts`) existed.
- Callers (rule 67 enumeration):
  - `assertDeploymentProvisioningAuthority`: only `assertFreshDeploymentProvisioningAuthority`
    in `provisionDeploymentNode` (fresh node path), invoked by `provisionNode` before `createVM`,
    after `createVM`, and again after `provisionNode` returns.
  - `provisionDeploymentNode`: release placement (`provisionNodeForRelease`) and Start
    (`startDeploymentEnvironment`).
  - `linkEnvironmentToNode`: `provisionDeploymentNode` (existing node `running`, fresh node
    `creating`) and `reserveExistingNodeForRelease` (`running`, release + reservation fenced).
  - `isPlacementCancellation`: six catch sites in `deployment-release-placement.ts` plus
    `createDeploymentReleaseFromManifest`.
- Statuses written to `deployment_environments.status`: `active`, `starting`, `stopping`,
  `stopped`, `deleting`, `error` (no shared enum).
- The heartbeat flips `starting` → `active` on `applied`, and `starting` → `error` on a failed apply.
- An `error` environment that keeps its node (failed apply) also cannot receive a fix release:
  `reserveExistingNodeForRelease` relinks it but its status stays `error`, so it is never advertised.
- The stale-release sweep (`runStaleDeploymentReleaseReconciliation`) requires a node observation
  after the release, so a release stranded with no node is never terminalized by it.
- UI: `canStart = status === 'stopped'`, `canStop` includes `error`. After the fix, Stop → Start is a
  working UI recovery path; a new release is the agent recovery path. No UI change needed.
- Pre-`createVM` authority refusals leave an `error` node row with no provider instance and no
  absence proof, so `cleanupFreshProvisioningNode` skips it (migration 0166 cleaned an earlier
  batch). Out of scope; tracked as a SAM idea.
- Hetzner capacity for cx23/fsn1 was back by 09:07Z (the `dev` environment node). Capacity
  fallback for deployment nodes is out of scope.

## Implementation checklist

- [x] `linkEnvironmentToNode`: in the same atomic write that links the node, move `error` →
      `active` and clear the stale `observed_status`/`observed_error_message`. Shared with
      `linkEnvironmentToLegacyNode` via `RECOVER_ERRORED_ENVIRONMENT_SET_SQL`
      (`deployment-environment-state.ts`). Every other status is left as it is.
      Design note: first cut moved `error` → `starting` (the legacy-adoption precedent). Changed to
      `active`: while `starting` lasts, Stop is refused (409) and agent deployment tools cannot see
      the environment, so a recovery that never finished would strand it. `active` is the status
      every release rolls out under; a failed apply then shows through the observed fields, exactly
      like a failed release on a healthy environment.
- [x] `assertDeploymentProvisioningAuthority`: accept `de.status IN ('active', 'starting')`
      (`starting` for Start). `error`, `stopping`, `stopped`, `deleting` refused; comment names why.
- [x] Stranded-placement reconciliation (`recordStrandedDeploymentReleasePlacement`): when a
      fresh-node placement is cancelled (`observeProvisioningResult`, `provisionNodeForRelease`),
      mark the release failed and the environment `error` with the reason only when nothing else
      explains it: the release is still the newest and still `created`, the environment is
      `active`/`error` (not Start-owned `starting`), no node is linked, no relocation claim.
- [x] Real-SQL tests (`tests/unit/services/deployment-error-recovery.test.ts`, SQLite built from
      the shipped migrations):
  - [x] Incident replay, with and without a volume: release → environment `active`, node
        provisioned through the real authority SQL (red before the fix).
  - [x] Recovery hitting capacity again returns to `error` with the new reason.
  - [x] Start from `stopped` and `error` reaches the provider (red before the fix).
  - [x] Failed apply keeps its node: the relink returns `error` to `active`; `starting` left alone.
  - [x] Authority admits `active`/`starting`, refuses `error`/`stopping`/`stopped`/`deleting`.
  - [x] Stopped/deleting environments never buy a server (with liveness assertions).
  - [x] Blocked placement → release `failed`, environment `error` with readable message;
        controls for superseded, stopping, Start in progress, stopped, deleting, node linked,
        relocation claim, release already moved on.
  - [x] Each fix and each predicate conjunct verified discriminating by reverting it.
- [x] Update the source-contract assertion in `provisioning-authority.test.ts`; legacy adoption
      tests expect `active`.
- [x] Docs: `app-deployments.md` "Recovering from a failed release"; `get_deployment_guide` text
      notes `error` environments accept `build_and_publish`.
- [x] SAM idea `01M5HGYYRBCJGWBKQK8HZEXA8F` for out-of-scope follow-ups (orphan placeholder
      nodes, deployment offering fallback, stale `created` releases, placement file size).

## Acceptance criteria

- [x] A new release for an `error` environment with no node provisions a node and leaves the
      environment `active` (test: incident replay).
- [x] A new release for an `error` environment that still has its node is advertised again
      (test: relink).
- [x] Start from `stopped` or `error` provisions a fresh node instead of failing the authority check.
- [x] Stopped, stopping and deleting environments still never reach the provider.
- [x] A placement blocked for an unexplained reason marks the release `failed` and shows the reason
      on the environment; superseded or stopped placements still write nothing.
- [ ] Staging: an environment forced into `error` recovers through a new release end to end.

## References

- `apps/api/src/services/provisioning-authority.ts` (`assertDeploymentProvisioningAuthority`)
- `apps/api/src/services/deployment-node-admission.ts` (`linkEnvironmentToNode`)
- `apps/api/src/services/deployment-legacy-node-admission.ts` (precedent `error` → `starting`)
- `apps/api/src/routes/deployment-release-placement.ts` (`observeProvisioningResult`,
  `isPlacementCancellation`)
- `apps/api/src/services/deployment-release-failure.ts`
- `apps/api/src/routes/node-lifecycle.ts` (heartbeat advertises `active`/`starting`)
- Rules: `apps/api/.claude/rules/71`, `67`, `58`, `69`, `.claude/rules/62`, `28`
