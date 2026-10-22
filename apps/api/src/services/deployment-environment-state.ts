/**
 * Shared SQL vocabulary for `deployment_environments` lifecycle state.
 *
 * Kept free of other service imports so the failure recorder
 * (deployment-release-failure.ts) and the admission writes
 * (deployment-node-admission.ts, deployment-legacy-node-admission.ts) can share
 * it without pulling in placement resolution.
 *
 * How an environment leaves `error`:
 * `markDeploymentReleasePlacementFailed` (deployment-release-failure.ts) and
 * `markEnvironmentStartFailed` (routes/deployment-environment-lifecycle.ts) park
 * an environment in `error`. The node heartbeat (`routes/node-lifecycle.ts`)
 * only advertises environments that are `active` or `starting`, and moves
 * `starting` to `active` once the node reports the release applied (or back to
 * `error` if the apply fails). An environment still in `error` is never
 * advertised, so a node linked to it would never receive the release.
 *
 * The way out is therefore to put the environment in `starting` in the same
 * write that admits a node for a new release. Both admission writes do this:
 * `linkEnvironmentToNode` (pooled and fresh nodes) and
 * `linkEnvironmentToLegacyNode` (pre-node-pool nodes). The paid provisioning
 * check, `assertDeploymentProvisioningAuthority` (provisioning-authority.ts),
 * accepts `starting` for the same reason.
 */

/** Reservation JSON field that fences an environment during relocation. */
export const DEPLOYMENT_RELOCATION_CLAIM_FIELD = 'samRelocationClaim';

/**
 * SET-clause fragment for an admission UPDATE whose environment alias is `de`.
 * SQLite evaluates every SET expression against the row as it was before the
 * update, so both columns read the old status.
 *
 * Only `error` moves; every other status is left as it is. `active` and
 * `starting` are already advertised, and `stopping`, `stopped` and `deleting`
 * belong to the Stop and Delete paths. `observed_error_message` is cleared
 * because it described the failed attempt; leaving it would keep the old error
 * on screen during the recovery.
 */
export const RECOVER_ERRORED_ENVIRONMENT_SET_SQL = `status = CASE WHEN de.status = 'error' THEN 'starting' ELSE de.status END,
            observed_error_message = CASE
              WHEN de.status = 'error' THEN NULL
              ELSE de.observed_error_message
            END`;
