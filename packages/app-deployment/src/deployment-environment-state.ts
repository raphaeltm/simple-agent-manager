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
 * only advertises environments that are `active` or `starting`, so a node
 * linked to an `error` environment would never receive the release.
 *
 * A new release is the documented way out, so both admission writes move the
 * environment out of `error` in the same write that admits its node:
 * `linkEnvironmentToNode` (pooled and fresh nodes) and
 * `linkEnvironmentToLegacyNode` (pre-node-pool nodes).
 */

/** Reservation JSON field that fences an environment during relocation. */
export const DEPLOYMENT_RELOCATION_CLAIM_FIELD = 'samRelocationClaim';

/**
 * SQL predicate: the environment aliased `de` has no relocation claim in flight.
 * A claim marks the reservation JSON while a placement moves the environment
 * between nodes; admission and release writes must not run under it.
 */
export const NO_DEPLOYMENT_RELOCATION_CLAIM_SQL = `CASE
            WHEN json_valid(de.resolved_reservation_json)
            THEN COALESCE(json_extract(de.resolved_reservation_json, '$.${DEPLOYMENT_RELOCATION_CLAIM_FIELD}'), 0)
            ELSE 0
          END = 0`;

/**
 * SET-clause fragment for an admission UPDATE whose environment alias is `de`.
 * SQLite evaluates every SET expression against the row as it was before the
 * update, so every column reads the old status.
 *
 * `error` becomes `active`, the status a release rolls out under on a healthy
 * environment. Not `starting`: that belongs to Start, while it lasts Stop is
 * refused and agent deployment tools cannot see the environment, so a recovery
 * that never finished would leave the environment stuck where neither the user
 * nor the agent could act. The observed fields described the failed attempt
 * and are cleared; the node's next report fills them in. Every status other
 * than `error` is left as it is.
 */
export const RECOVER_ERRORED_ENVIRONMENT_SET_SQL = `status = CASE WHEN de.status = 'error' THEN 'active' ELSE de.status END,
            observed_status = CASE
              WHEN de.status = 'error' THEN NULL
              ELSE de.observed_status
            END,
            observed_error_message = CASE
              WHEN de.status = 'error' THEN NULL
              ELSE de.observed_error_message
            END`;
