import { isTransientCapacityError, ProviderError, type ProviderRequestContext, rethrowIfProviderRequestAborted } from '@simple-agent-manager/providers';
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { and, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { GcpApiError, sanitizeGcpError } from './gcp-errors';
import { type DurableNodeAllocation,NodeAllocationUncertainError } from './node-allocation-recovery';
import type { ProvisionNodeOptions } from './node-provisioning';
import { settleNodeTunnelIngress } from './node-provisioning-ingress';
import { creatingProvisioningPredicate, releaseTunnelBeforeVm, truncateNodeErrorMessage } from './node-provisioning-predicates';
import type { NodeTunnelProvisioningPhase } from './node-tunnel-provisioning';
import { recordTunnelProvisioningFailure } from './node-tunnel-provisioning-failure';
import { persistError } from './observability';

/** Failure finalization, extracted without changing ordering or predicates. */
export async function handleNodeProvisioningFailure(err: unknown, input: {
  env: Env;
  node: typeof schema.nodes.$inferSelect;
  options?: ProvisionNodeOptions;
  durable?: DurableNodeAllocation;
  db: ReturnType<typeof drizzle<typeof schema>>;
  tunnelJournaled: boolean;
  provisioningRuntimeIncarnationId: string | null;
  tunnelPhase: NodeTunnelProvisioningPhase | null;
  providerCreateRequested: boolean;
  providerContext?: ProviderRequestContext;
  attemptedProvider?: CredentialProvider;
  providerCreateRejected: boolean;
  providerAllocationRejected: boolean;
  providerRejectionProofAt: string | null;
  rejectedPlacementPredicate: ReturnType<typeof and>;
}): Promise<void> {
  const { env, node, options, durable, db, tunnelJournaled, provisioningRuntimeIncarnationId, tunnelPhase, providerCreateRequested, providerContext, attemptedProvider, providerCreateRejected, providerAllocationRejected, providerRejectionProofAt, rejectedPlacementPredicate } = input;
  // Record the cause first, aborts included: the abort branches below rethrow before any
  // other log or row write, which left staging failures with no recorded cause.
  if (tunnelJournaled && provisioningRuntimeIncarnationId) {
    await recordTunnelProvisioningFailure(env, {
      nodeId: node.id,
      runtimeIncarnationId: provisioningRuntimeIncarnationId,
      phase: tunnelPhase ?? (providerCreateRequested ? 'provider_create' : 'before_provider'),
      durable: !!durable,
      aborted: options?.signal?.aborted === true,
      error: err,
    });
  }
  // Only a non-durable call can release before the VM: it minted this incarnation and will
  // never resume it. A durable allocation resumes the SAME incarnation on its next attempt
  // (a released row would refuse it forever), and an earlier attempt of it may already have
  // a VM holding this token. Its row is released by node teardown or the sweep once the
  // incarnation is no longer live.
  if (
    tunnelJournaled &&
    !durable &&
    !providerCreateRequested &&
    provisioningRuntimeIncarnationId
  ) {
    await releaseTunnelBeforeVm(env, node.id, provisioningRuntimeIncarnationId);
  }
  if (err instanceof NodeAllocationUncertainError) throw err;
  rethrowIfProviderRequestAborted(err, providerContext);
  try {
    // Sanitize GCP errors to prevent leaking resource paths in client-visible errorMessage
    const errorMessage =
      err instanceof GcpApiError
        ? sanitizeGcpError(err, 'node-provisioning')
        : err instanceof Error
          ? err.message
          : String(err);
    const providerName = attemptedProvider ?? 'unknown';
    const statusCode = err instanceof ProviderError ? err.statusCode : undefined;

    log.error('node_provisioning.failed', {
      nodeId: node.id,
      provider: providerName,
      vmSize: node.vmSize,
      vmLocation: node.vmLocation,
      statusCode,
      error: errorMessage,
    });

    // Persist detailed error to observability database
    try {
      await persistError(
        env.OBSERVABILITY_DATABASE,
        {
          source: 'api',
          level: 'error',
          message: `Node provisioning failed: ${errorMessage}`,
          context: {
            component: 'node-provisioning',
            nodeId: node.id,
            userId: node.userId,
            provider: providerName,
            vmSize: node.vmSize,
            vmLocation: node.vmLocation,
            statusCode,
          },
          nodeId: node.id,
          userId: node.userId,
        },
        env
      );
    } catch (obsErr) {
      log.error('node_provisioning.observability_persist_failed', serializeError(obsErr));
    }

    const isCapacityFailure = err instanceof ProviderError && isTransientCapacityError(err);

    // Descent-loop mode: re-throw so the caller can branch on the error category.
    // Delete the failed node row when the create boundary proved the provider rejected
    // allocation before returning a VM identity; there is no runtime to tear down.
    if (options?.rethrowProviderError) {
      if ((isCapacityFailure && !providerCreateRejected) || providerAllocationRejected) {
        if (
          providerAllocationRejected &&
          (!providerRejectionProofAt || !rejectedPlacementPredicate)
        ) {
          throw new Error('Rejected allocation proof identity is unavailable');
        }
        await options.beforeRejectedNodeDelete?.();
        await db
          .delete(schema.nodes)
          .where(
            and(
              creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId),
              ...(providerAllocationRejected
                ? [
                    sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${providerRejectionProofAt}`,
                    rejectedPlacementPredicate,
                  ]
                : [])
            )
          )
          .run();
      } else {
        const truncatedError = truncateNodeErrorMessage(errorMessage);
        await db
          .update(schema.nodes)
          .set({
            status: 'error',
            healthStatus: 'unhealthy',
            errorMessage: `[${providerName}] ${truncatedError}`,
            ...(providerAllocationRejected
              ? { runtimeTerminationConfirmedAt: new Date().toISOString() }
              : {}),
            updatedAt: new Date().toISOString(),
            cleanupBlockedSince: null,
            cleanupBlockedReason: null,
            cleanupBlockedAlertedAt: null,
          })
          .where(creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId))
          .run();
      }
      throw err;
    }

    // Legacy mode: store the actual error message (truncated) in the node record.
    const truncatedError = truncateNodeErrorMessage(errorMessage);
    await db
      .update(schema.nodes)
      .set({
        status: 'error',
        healthStatus: 'unhealthy',
        errorMessage: `[${providerName}] ${truncatedError}`,
        ...(providerAllocationRejected
          ? { runtimeTerminationConfirmedAt: new Date().toISOString() }
          : {}),
        updatedAt: new Date().toISOString(),
        cleanupBlockedSince: null,
        cleanupBlockedReason: null,
        cleanupBlockedAlertedAt: null,
      })
      .where(creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId))
      .run();
  } finally {
    // After the row writes above: a deleted row or rejection proof makes the incarnation
    // non-live, which releases its tunnel. A possibly-created VM keeps it until node
    // teardown records termination proof. Never throws; the cron sweep is the backstop.
    if (tunnelJournaled) await settleNodeTunnelIngress(env, node.id, 'provisioning_failed');
  }
}
