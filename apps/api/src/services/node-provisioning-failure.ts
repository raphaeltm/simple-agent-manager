import {
  isProviderCreateNotDispatched,
  isTransientCapacityError,
  ProviderError,
  type ProviderRequestContext,
  rethrowIfProviderRequestAborted,
} from '@simple-agent-manager/providers';
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { and, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { GcpApiError, sanitizeGcpError } from './gcp-errors';
import {
  type DurableNodeAllocation,
  NodeAllocationUncertainError,
} from './node-allocation-recovery';
import type { ProvisionNodeOptions } from './node-provisioning';
import { settleNodeTunnelIngress } from './node-provisioning-ingress';
import {
  creatingProvisioningPredicate,
  releaseTunnelBeforeVm,
  truncateNodeErrorMessage,
} from './node-provisioning-predicates';
import { recordRejectedAllocationAbsence } from './node-rejection-proof';
import type { NodeTunnelProvisioningPhase } from './node-tunnel-provisioning';
import { recordTunnelProvisioningFailure } from './node-tunnel-provisioning-failure';
import { persistError } from './observability';

interface NodeProvisioningFailureInput {
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
}

/** Failure finalization preserves allocation and release ordering. */
export async function handleNodeProvisioningFailure(
  err: unknown,
  input: NodeProvisioningFailureInput
): Promise<void> {
  const {
    env,
    node,
    options,
    durable,
    tunnelJournaled,
    provisioningRuntimeIncarnationId,
    tunnelPhase,
    providerCreateRequested,
    providerContext,
  } = input;
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
  if (tunnelJournaled && !durable && !providerCreateRequested && provisioningRuntimeIncarnationId) {
    await releaseTunnelBeforeVm(env, node.id, provisioningRuntimeIncarnationId);
  }
  if (err instanceof NodeAllocationUncertainError) throw err;
  rethrowIfProviderRequestAborted(err, providerContext);
  try {
    await finalizeNodeProvisioningFailure(err, input);
  } finally {
    // After the row writes above: a deleted row or rejection proof makes the incarnation
    // non-live, which releases its tunnel. A possibly-created VM keeps it until node
    // teardown records termination proof. Never throws; the cron sweep is the backstop.
    if (tunnelJournaled) await settleNodeTunnelIngress(env, node.id, 'provisioning_failed');
  }
}

function provisioningFailureMessage(err: unknown): string {
  if (err instanceof GcpApiError) return sanitizeGcpError(err, 'node-provisioning');
  return err instanceof Error ? err.message : String(err);
}

async function recordNodeProvisioningError(
  err: unknown,
  input: NodeProvisioningFailureInput,
  errorMessage: string
): Promise<void> {
  const { env, node, attemptedProvider } = input;
  // Sanitize GCP errors to prevent leaking resource paths in client-visible errorMessage
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
}

async function finalizeNodeProvisioningFailure(
  err: unknown,
  input: NodeProvisioningFailureInput
): Promise<void> {
  // Only a terminal, fresh non-durable allocation may consume the adapter's positive
  // pre-dispatch proof. Durable attempts retry the same incarnation; marking it terminated
  // here would poison that retry. An initially unproven incarnation may have an earlier
  // dispatched create, so it also stays unresolved (never infer absence from STS text).
  if (
    !input.durable &&
    input.node.runtimeTerminationConfirmedAt !== null &&
    input.attemptedProvider &&
    isProviderCreateNotDispatched(err)
  ) {
    const proof = await recordRejectedAllocationAbsence(
      input.db,
      input.node,
      {
        providerName: input.attemptedProvider,
        // Match the original placement snapshot; never re-resolve a rotated credential.
        exactCredentialBinding: undefined,
      },
      input.provisioningRuntimeIncarnationId
    );
    input.providerAllocationRejected = !!proof;
    input.providerRejectionProofAt = proof?.proofAt ?? null;
    input.rejectedPlacementPredicate = proof?.placementPredicate;
  }
  const { options, providerCreateRejected, providerAllocationRejected } = input;
  const errorMessage = provisioningFailureMessage(err);
  await recordNodeProvisioningError(err, input, errorMessage);
  const isCapacityFailure = err instanceof ProviderError && isTransientCapacityError(err);
  // Descent-loop mode deletes only a proven pre-identity rejection, then rethrows the
  // original error so its caller can choose another capacity offering.
  if (
    options?.rethrowProviderError &&
    ((isCapacityFailure && !providerCreateRejected) || providerAllocationRejected)
  ) {
    await deleteRejectedProvisioningNode(input);
  } else {
    await recordFailedProvisioningNode(input, errorMessage);
  }
  if (options?.rethrowProviderError) throw err;
}

async function deleteRejectedProvisioningNode(input: NodeProvisioningFailureInput): Promise<void> {
  const {
    node,
    options,
    db,
    provisioningRuntimeIncarnationId,
    providerAllocationRejected,
    providerRejectionProofAt,
    rejectedPlacementPredicate,
  } = input;
  if (providerAllocationRejected && (!providerRejectionProofAt || !rejectedPlacementPredicate)) {
    throw new Error('Rejected allocation proof identity is unavailable');
  }
  await options?.beforeRejectedNodeDelete?.();
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
}

async function recordFailedProvisioningNode(
  input: NodeProvisioningFailureInput,
  errorMessage: string
): Promise<void> {
  const {
    node,
    db,
    provisioningRuntimeIncarnationId,
    attemptedProvider,
    providerAllocationRejected,
  } = input;
  const providerName = attemptedProvider ?? 'unknown';
  const truncatedError = truncateNodeErrorMessage(errorMessage);
  await db
    .update(schema.nodes)
    .set({
      status: 'error',
      healthStatus: 'unhealthy',
      errorMessage: `[${providerName}] ${truncatedError}`,
      ...(providerAllocationRejected
        ? { runtimeTerminationConfirmedAt: input.providerRejectionProofAt }
        : {}),
      updatedAt: new Date().toISOString(),
      cleanupBlockedSince: null,
      cleanupBlockedReason: null,
      cleanupBlockedAlertedAt: null,
    })
    .where(
      and(
        creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId),
        ...(providerAllocationRejected
          ? [
              sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${input.providerRejectionProofAt}`,
              input.rejectedPlacementPredicate,
            ]
          : [])
      )
    )
    .run();
}
