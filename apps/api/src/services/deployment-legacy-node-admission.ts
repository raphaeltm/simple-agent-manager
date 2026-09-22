/**
 * Legacy (pre-node-pool) deployment node adoption.
 *
 * PR #2114 routed every release for an environment that is already linked to a
 * deployment node through `reserveExistingNodeForRelease` →
 * `findDeploymentNodeWithCapacity` + `linkEnvironmentToNode`. That admission
 * requires pooled placement identity (`capacity_pool_id`) and trusted observed
 * hardware (`observed_hardware_source = 'observed'`, observed vcpu/memory/disk
 * > 0, `provider_instance_type`). `resolveReusableNodeCapacitySnapshot`
 * explicitly returns `undefined` for a node with no `capacity_pool_id`
 * ("Legacy nodes drain once any effective pool exists").
 *
 * Deployment nodes provisioned before the node-pool system have every one of
 * those columns NULL, so an environment that has been happily running on one
 * for months can no longer receive a release at all — production environment
 * `01M100A361P49T716X6QBV2NV5` (project APEX) failed release v15 with
 * "Existing exclusive deployment node cannot admit the declared resource
 * reservation" on 2026-09-21.
 *
 * The product decision is that such an environment keeps deploying to the node
 * it is already on. This module implements that adoption as ONE atomic
 * reservation write that repeats every invariant in its own predicate
 * (`apps/api/.claude/rules/69-aggregate-capacity-at-final-reservation.md`):
 * the environment must already be on this node, the node must be a running,
 * healthy, deployment-role node owned by the release's user, the node must
 * still be legacy-shaped, occupancy must respect the node mode, the release
 * must still be the newest one, and the stored reservation must be exactly what
 * the caller observed.
 *
 * This path NEVER adopts a node the environment is not already linked to, and
 * never adopts a pooled node or a node carrying trusted observed hardware —
 * those have the real capacity-aware admission path in
 * `deployment-node-admission.ts`.
 */
import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE,
  DEPLOYMENT_RELOCATION_CLAIM_FIELD,
} from './deployment-node-admission';

export interface LinkEnvironmentToLegacyNodeOptions {
  env: Env;
  /** Environment that must ALREADY be linked to `nodeId`. */
  envId: string;
  /** Node the environment is already running on. */
  nodeId: string;
  /** Owner of the release; must own the node too. */
  userId: string;
  /** Admission succeeds only while this is still the newest release. */
  releaseId: string;
  /** Latest manifest declares persistent volumes (implies an exclusive node). */
  requiresVolumes: boolean;
  /** Exact aggregate reservation persisted by this admission. */
  reservation: ResolvedResourceReservation;
  /** CAS guard: the reservation JSON the caller observed (NULL for legacy rows). */
  expectedReservationJson: string | null;
}

/**
 * Atomically re-reserve the legacy deployment node an environment already runs
 * on, and unblock release delivery for it.
 *
 * The `status` flip is load-bearing, not cosmetic: the node heartbeat only
 * advertises `pendingReleases` for environments whose status is `active` or
 * `starting` (`apps/api/src/routes/node-lifecycle.ts`), and the only transition
 * back out of `error` is the `'starting'` → `'active'` move the heartbeat makes
 * when the node reports the release applied. An environment parked in `error`
 * by a placement failure would therefore never receive another release.
 *
 * @returns true when the reservation was written, false when any invariant failed.
 */
export async function linkEnvironmentToLegacyNode(
  opts: LinkEnvironmentToLegacyNodeOptions
): Promise<boolean> {
  const { env, envId, nodeId, userId, releaseId, reservation } = opts;
  if (typeof env.DATABASE.prepare !== 'function') return false;

  // requiresVolumes and an exclusive-node reservation both demand a node with
  // no co-tenants, mirroring `linkEnvironmentToNode`'s nodeMode/exclusiveNode
  // agreement check. A shared node can never satisfy such a release.
  const requiresExclusiveNode = opts.requiresVolumes || reservation.exclusiveNode;
  const maxEnvironments = parsePositiveInt(
    env.MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE,
    DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE
  );
  const now = new Date().toISOString();

  const result = await env.DATABASE.prepare(
    `UPDATE deployment_environments AS de
        SET resolved_reservation_json = ?,
            updated_at = ?,
            status = CASE WHEN de.status = 'error' THEN 'starting' ELSE de.status END,
            observed_error_message = CASE
              WHEN de.status = 'error' THEN NULL
              ELSE de.observed_error_message
            END
       FROM nodes n
      WHERE de.id = ?
        AND de.node_id = n.id
        AND n.id = ?
        AND n.user_id = ?
        AND n.status = 'running'
        AND n.node_role = 'deployment'
        AND COALESCE(n.health_status, 'healthy') != 'unhealthy'
        AND n.capacity_pool_id IS NULL
        AND n.observed_hardware_source IS NULL
        AND n.provider_instance_type IS NULL
        ${requiresExclusiveNode ? `AND COALESCE(n.node_mode, 'shared') = 'exclusive'` : ''}
        AND (
          SELECT COUNT(*)
          FROM deployment_environments occupied
          WHERE occupied.node_id = n.id AND occupied.id != de.id
        ) < CASE WHEN COALESCE(n.node_mode, 'shared') = 'exclusive' THEN 1 ELSE ? END
        AND ? = (
          SELECT latest.id FROM deployment_releases latest
          WHERE latest.environment_id = de.id
          ORDER BY latest.version DESC
          LIMIT 1
        )
        AND de.resolved_reservation_json IS ?
        AND CASE
          WHEN json_valid(de.resolved_reservation_json)
          THEN COALESCE(json_extract(de.resolved_reservation_json, '$.${DEPLOYMENT_RELOCATION_CLAIM_FIELD}'), 0)
          ELSE 0
        END = 0`
  )
    .bind(
      JSON.stringify(reservation),
      now,
      envId,
      nodeId,
      userId,
      maxEnvironments,
      releaseId,
      opts.expectedReservationJson
    )
    .run();

  const adopted = (result.meta?.changes ?? 0) > 0;
  if (adopted) {
    log.info('deployment_release.legacy_node_adopted', {
      envId,
      nodeId,
      releaseId,
      requiresExclusiveNode,
    });
  }
  return adopted;
}
