/**
 * Deployment-node half of the VM-agent heartbeat (`POST /nodes/:id/heartbeat`).
 *
 * Extracted from `node-lifecycle.ts` (rule 18). For each environment placed on the
 * authenticated node it folds the agent's observed deployment state into
 * `deployment_environments`, reconciles release and routing observations, and adds the
 * pending releases and route configs to the heartbeat response.
 *
 * SECURITY: environments are looked up from the authenticated node's placement records,
 * never from environment IDs in the request body (IDOR risk).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';
import type * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import type { NodeHeartbeatSchema } from '../schemas';
import {
  buildObservedDeploymentUpdate,
  reconcileDeploymentReleaseStatuses,
} from '../services/deployment-control';
import { reconcileCustomDomainRoutingObservation } from '../services/deployment-custom-domains';
import {
  recordDeploymentEnvironmentLifecycleEventBestEffort,
  recordDeploymentReleaseLifecycleEventBestEffort,
} from '../services/project-lifecycle-events';

type HeartbeatDeployment = NonNullable<v.InferOutput<typeof NodeHeartbeatSchema>['deployment']>;

async function deploymentVolumesReadyForNode(params: {
  database: Env['DATABASE'];
  environmentId: string;
  eventName: string;
  nodeId: string;
  providerInstanceId: string | null | undefined;
  requiresVolumes: boolean;
}): Promise<boolean> {
  if (!params.requiresVolumes) {
    return true;
  }

  const volumeReadiness = await params.database
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN attached_server_id = ? THEN 1 END) AS attached
       FROM deployment_volumes
       WHERE environment_id = ?`
    )
    .bind(params.providerInstanceId ?? '', params.environmentId)
    .first<{ total: number; attached: number }>();

  if (
    !volumeReadiness ||
    volumeReadiness.total === 0 ||
    volumeReadiness.attached < volumeReadiness.total
  ) {
    log.info(params.eventName, {
      nodeId: params.nodeId,
      environmentId: params.environmentId,
      total: volumeReadiness?.total ?? 0,
      attached: volumeReadiness?.attached ?? 0,
    });
    return false;
  }

  return true;
}

export async function applyDeploymentHeartbeat(params: {
  c: Context<{ Bindings: Env }>;
  db: ReturnType<typeof drizzle<typeof schema>>;
  node: Pick<schema.Node, 'providerInstanceId'>;
  nodeId: string;
  deployment: HeartbeatDeployment;
  now: string;
  response: Record<string, unknown>;
}): Promise<void> {
  const { c, db, node, nodeId, deployment, now, response } = params;
  try {
    const envRows = await db
      .select({
        envId: schema.deploymentEnvironments.id,
        projectId: schema.deploymentEnvironments.projectId,
        status: schema.deploymentEnvironments.status,
        requiresVolumes: schema.deploymentEnvironments.requiresVolumes,
        observedAppliedSeq: schema.deploymentEnvironments.observedAppliedSeq,
        observedStatus: schema.deploymentEnvironments.observedStatus,
        desiredRoutingRevision: schema.deploymentEnvironments.desiredRoutingRevision,
        observedRoutingRevision: schema.deploymentEnvironments.observedRoutingRevision,
      })
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.nodeId, nodeId));
    const activeEnvRows = envRows.filter(
      (row) => row.status === 'active' || row.status === 'starting'
    );
    const placedEnvIds = new Set(activeEnvRows.map((row) => row.envId));
    const bodyStates = Array.isArray(deployment.environments) ? deployment.environments : [];
    const reportedEnvIds = Array.from(
      new Set(
        bodyStates
          .map((state) => state.environmentId.trim())
          .filter((environmentId) => environmentId.length > 0)
      )
    );
    const retireEnvironments = reportedEnvIds
      .filter((environmentId) => !placedEnvIds.has(environmentId))
      .map((environmentId) => ({ environmentId }));

    response.deployment = {
      environments: activeEnvRows.map((row) => ({ environmentId: row.envId })),
      ...(retireEnvironments.length > 0 ? { retireEnvironments } : {}),
    };

    const stateByEnv = new Map(bodyStates.map((state) => [state.environmentId, state]));

    const pendingReleases: Array<{ environmentId: string; seq: number }> = [];
    const pendingRouteConfigs: Array<{ environmentId: string; revision: number }> = [];

    for (const envRow of activeEnvRows) {
      const envId = envRow.envId;
      const bodyState = stateByEnv.get(envId);
      const deploymentState = bodyState ?? null;
      const appliedSeq = deploymentState?.appliedSeq ?? envRow.observedAppliedSeq ?? 0;

      if (deploymentState) {
        const observedUpdate = buildObservedDeploymentUpdate(deploymentState, now);
        if (envRow.status === 'starting' && deploymentState.status === 'applied') {
          observedUpdate.status = 'active';
        } else if (
          envRow.status === 'starting' &&
          (deploymentState.status === 'failed' || deploymentState.status === 'failed-initial')
        ) {
          observedUpdate.status = 'error';
        }

        // Compare-and-set on the status read above. The `starting → active/error`
        // decision was made from that read, so a stop, start failure or deletion that
        // landed in between must win: without the status predicate this write would
        // overwrite it (read-then-write race).
        const applied = await db
          .update(schema.deploymentEnvironments)
          .set(observedUpdate)
          .where(
            and(
              eq(schema.deploymentEnvironments.id, envId),
              eq(schema.deploymentEnvironments.nodeId, nodeId),
              eq(schema.deploymentEnvironments.status, envRow.status)
            )
          )
          .returning({ id: schema.deploymentEnvironments.id });
        if (applied.length === 0) {
          // The environment changed under us. Its new status owns what happens next;
          // the next heartbeat re-reads it, so skip events and release work for now.
          log.info('heartbeat.deployment_environment_status_changed', {
            nodeId,
            environmentId: envId,
            readStatus: envRow.status,
            action: 'skipped_observation',
          });
          continue;
        }

        const nextObservedStatus =
          typeof observedUpdate.observedStatus === 'string' ? observedUpdate.observedStatus : null;
        const nextObservedAppliedSeq =
          typeof observedUpdate.observedAppliedSeq === 'number'
            ? observedUpdate.observedAppliedSeq
            : null;
        const nextEnvironmentStatus =
          typeof observedUpdate.status === 'string' ? observedUpdate.status : envRow.status;
        const environmentStatusChanged = nextEnvironmentStatus !== envRow.status;
        const observedStatusChanged =
          nextObservedStatus !== null && nextObservedStatus !== (envRow.observedStatus ?? null);
        const observedAppliedSeqChanged =
          nextObservedAppliedSeq !== null &&
          nextObservedAppliedSeq !== (envRow.observedAppliedSeq ?? null);
        if (environmentStatusChanged || observedStatusChanged || observedAppliedSeqChanged) {
          c.executionCtx.waitUntil(
            recordDeploymentEnvironmentLifecycleEventBestEffort(c.env, {
              projectId: envRow.projectId,
              environmentId: envId,
              lifecycle:
                environmentStatusChanged && nextEnvironmentStatus === 'active'
                  ? 'active'
                  : environmentStatusChanged && nextEnvironmentStatus === 'error'
                    ? 'error'
                    : 'observed',
              status: nextEnvironmentStatus,
              fromStatus: envRow.status,
              observedStatus: nextObservedStatus,
              observedAppliedSeq: nextObservedAppliedSeq,
              nodeId,
              source: 'node.heartbeat_deployment_observation',
              occurredAt: now,
            })
          );
        }

        const releaseTransitions =
          (await reconcileDeploymentReleaseStatuses(db, envId, deploymentState)) ?? [];
        for (const transition of releaseTransitions) {
          c.executionCtx.waitUntil(
            recordDeploymentReleaseLifecycleEventBestEffort(c.env, {
              projectId: envRow.projectId,
              releaseId: transition.releaseId,
              environmentId: envId,
              status: transition.toStatus,
              fromStatus: transition.fromStatus,
              version: transition.version,
              nodeId,
              source: 'node.heartbeat_release_reconciliation',
              occurredAt: transition.occurredAt,
            })
          );
        }
        if (typeof deploymentState.routingRevision === 'number') {
          await reconcileCustomDomainRoutingObservation(
            db,
            envId,
            Math.floor(deploymentState.routingRevision),
            deploymentState.routingStatus,
            now
          );
        }
      }

      const latestRelease = await db
        .select({
          version: schema.deploymentReleases.version,
          status: schema.deploymentReleases.status,
        })
        .from(schema.deploymentReleases)
        .where(eq(schema.deploymentReleases.environmentId, envId))
        .orderBy(desc(schema.deploymentReleases.version))
        .limit(1);

      const latest = latestRelease[0];
      const nodeAlreadyApplying = deploymentState?.status === 'applying';
      if (
        latest &&
        latest.version > appliedSeq &&
        (latest.status === 'created' || (latest.status === 'applying' && !nodeAlreadyApplying))
      ) {
        if (
          !(await deploymentVolumesReadyForNode({
            database: c.env.DATABASE,
            environmentId: envId,
            eventName: 'heartbeat.deploy_release_waiting_for_volume_attach',
            nodeId,
            providerInstanceId: node.providerInstanceId,
            requiresVolumes: envRow.requiresVolumes,
          }))
        ) {
          continue;
        }
        pendingReleases.push({ environmentId: envId, seq: latest.version });
      }

      const reportedRoutingRevision =
        typeof deploymentState?.routingRevision === 'number'
          ? Math.floor(deploymentState.routingRevision)
          : (envRow.observedRoutingRevision ?? 0);
      const desiredRoutingRevision = envRow.desiredRoutingRevision ?? 0;
      const hasCurrentAppliedRelease = !!latest && appliedSeq > 0 && latest.version <= appliedSeq;
      if (
        desiredRoutingRevision > reportedRoutingRevision &&
        hasCurrentAppliedRelease &&
        !nodeAlreadyApplying
      ) {
        if (
          !(await deploymentVolumesReadyForNode({
            database: c.env.DATABASE,
            environmentId: envId,
            eventName: 'heartbeat.deploy_routes_waiting_for_volume_attach',
            nodeId,
            providerInstanceId: node.providerInstanceId,
            requiresVolumes: envRow.requiresVolumes,
          }))
        ) {
          continue;
        }
        pendingRouteConfigs.push({ environmentId: envId, revision: desiredRoutingRevision });
      }
    }

    if (pendingReleases.length > 0) {
      // `deployment.pendingReleases` is the ONLY advertisement of a pending
      // release. The legacy top-level `pendingReleaseSeq` carried a duplicate of
      // the lone entry, which health.go appended to this same list under its own
      // cloud-init ENVIRONMENT_ID — two apply goroutines per tick, mis-attributed
      // on multi-environment nodes. Rollout-safe to drop: the agent gained
      // `pendingReleases` in the same commit that started emitting it (703b8b56f,
      // 2026-06-21), and it still honours the legacy field as a fallback when this
      // list is absent.
      response.deployment = {
        ...(response.deployment as Record<string, unknown>),
        pendingReleases,
      };
    }
    if (pendingRouteConfigs.length > 0) {
      response.deployment = {
        ...(response.deployment as Record<string, unknown>),
        pendingRouteConfigs,
      };
    }
  } catch (err) {
    log.warn('heartbeat.deploy_release_lookup_failed', {
      nodeId,
      error: String(err),
    });
  }

  // Include deploy signing public key for key refresh
  if (c.env.DEPLOY_SIGNING_PUBLIC_KEY) {
    response.deployPubKey = c.env.DEPLOY_SIGNING_PUBLIC_KEY;
    response.deployment = {
      ...(typeof response.deployment === 'object' && response.deployment !== null
        ? (response.deployment as Record<string, unknown>)
        : {}),
      deployPubKey: c.env.DEPLOY_SIGNING_PUBLIC_KEY,
    };
  }
}
