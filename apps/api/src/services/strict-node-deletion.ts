import { type ProviderRequestContext } from '@simple-agent-manager/providers';
import {
  DEFAULT_NODE_PROVIDER_DELETION_CONFIRM_MAX_MS,
  DEFAULT_NODE_PROVIDER_DELETION_REQUEST_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { isUserOwnedNodeClass } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { releaseNodeAppRouteDnsRecords } from './app-route-dns-reconciliation';
import { recoverLegacyDeploymentBinding } from './deployment-legacy-binding';
import { captureNodeLogsBeforeTeardown } from './node-log-capture';
import { isNeverRequestedVmPlaceholder } from './node-never-requested-placeholder';
import {
  boundedConfirmationError,
  clearProviderDeletionRecord,
  confirmPendingProviderDeletion,
  pendingProviderDeletionFor,
  type ProviderDeletionMode,
  type ProviderDeletionOutcome,
  sendProviderDeletion,
} from './node-provider-deletion';
import { releaseTerminatedNodeIngress } from './node-provisioning-ingress';
import {
  deleteWithCurrentOwnerCredential,
  NodeTeardownBlockedError,
  resolveStrictNodeTeardownAuthority,
} from './node-teardown-authority';
import { recordNodeTeardownBlocked } from './node-teardown-blocked';
import { isNodeCapacitySourceReleased } from './node-teardown-provenance';
import {
  type ContainerWorkspaceDeletionAuthority,
  requireNodeWorkspaceArtifactsDeleted,
} from './node-workspace-retirement-guard';
import type { PreservedVmRetirement } from './preserved-vm-retirement';
import {
  exactNodeIncarnationPredicate,
  hasManagedVmPlacementProof,
  type NodeDb,
  type NodeRow,
  requireSameNodeIncarnation,
  requireStrictNode,
} from './strict-node-deletion-shared';
import { deleteStrictNodeDnsRecord } from './strict-node-dns-cleanup';
import { reconcileStrictProviderlessVm } from './strict-node-providerless-reconcile';
import {
  markRuntimeTerminationConfirmed,
  markWorkspaceRuntimeTerminationConfirmed,
} from './strict-node-termination-proof';
import { destroyVmAgentContainer } from './vm-agent-container';

export type StrictNodeDeletionResult = {
  /**
   * `deletion_pending`: only in `providerDeletion: 'request'` mode. The provider deletion was
   * started (or is still running) and no termination proof was written; call again later.
   */
  providerVm: 'no-instance' | 'deleted' | 'already-absent' | 'deletion_pending';
  runtimeTerminationConfirmedAt: string | null;
  runtimeIncarnationId: string | null;
  providerInstanceId: string | null;
};

export interface StrictNodeRuntimeIdentity {
  userId: string;
  runtime: string;
  providerInstanceId: string | null;
  runtimeIncarnationId: string | null;
}

function matchesExpectedRuntime(
  node: NodeRow,
  expected: StrictNodeRuntimeIdentity | undefined
): boolean {
  return (
    !expected ||
    (node.userId === expected.userId &&
      node.runtime === expected.runtime &&
      node.providerInstanceId === expected.providerInstanceId &&
      node.runtimeIncarnationId === expected.runtimeIncarnationId)
  );
}

interface ProviderDeletionOptions {
  mode: ProviderDeletionMode;
  confirmMaxMs: number;
  /** How long after its record a sent DELETE may still be in flight (see `confirmPending…`). */
  sendGraceMs: number;
}

async function deleteStrictProviderInstance(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env,
  deletion: ProviderDeletionOptions,
  requestContext?: ProviderRequestContext,
  beforeDestroy?: () => Promise<void>
): Promise<ProviderDeletionOutcome> {
  const providerInstanceId = node.providerInstanceId;
  if (!providerInstanceId) {
    throw new Error(
      `Cannot confirm managed VM termination for node ${node.id}: instance identity is missing`
    );
  }

  // A deletion this exact runtime already started (two-phase mode) is resolved from the
  // provider's own record. Its pre-delete guards ran before the record was written, and the
  // delete may already be done, so they are not re-run; a record the provider shows to be void is
  // cleared and the next attempt runs the guarded path again. Every failure on this path is bounded
  // by the record's age (`boundedConfirmationError`), including credential resolution.
  const pending = pendingProviderDeletionFor(node);
  if (pending) {
    let outcome: ProviderDeletionOutcome;
    try {
      const authority = await resolveStrictNodeTeardownAuthority(db, node, userId, env);
      await requireSameNodeIncarnation(db, node, 'provider deletion confirmation');
      const providers =
        authority.kind === 'pinned'
          ? [authority.providerResult.provider]
          : authority.candidates.map((candidate) => candidate.provider);
      outcome = await confirmPendingProviderDeletion(
        db,
        node,
        providers,
        pending,
        { confirmMaxMs: deletion.confirmMaxMs, sendGraceMs: deletion.sendGraceMs },
        requestContext
      );
    } catch (error) {
      throw boundedConfirmationError(node, pending, deletion.confirmMaxMs, error);
    }
    if (outcome === 'deletion_pending' && deletion.mode === 'wait') {
      throw new Error(
        `Provider deletion of node ${node.id} started at ${pending.requestedAt} is still in progress; retry shortly`
      );
    }
    return outcome;
  }

  const authority = await resolveStrictNodeTeardownAuthority(db, node, userId, env);
  await requireSameNodeIncarnation(db, node, 'provider delete');
  await beforeDestroy?.();
  // Black box recorder: bounded and best-effort, never blocks teardown beyond its timeout.
  await captureNodeLogsBeforeTeardown(env, node);
  if (authority.kind === 'pinned') {
    return await sendProviderDeletion(
      db,
      node,
      authority.providerResult.provider,
      deletion.mode,
      deletion.sendGraceMs,
      requestContext
    );
  }
  // The placement credential no longer resolves (rotated, re-saved, reconnected). Ownership
  // comes from the instance itself, read immediately before each delete.
  return await deleteWithCurrentOwnerCredential(
    node,
    env,
    authority.candidates,
    async () => {
      await requireSameNodeIncarnation(db, node, 'provider delete after ownership proof');
    },
    requestContext,
    (provider) =>
      sendProviderDeletion(db, node, provider, deletion.mode, deletion.sendGraceMs, requestContext)
  );
}

async function claimManagedNodeDeletion(db: NodeDb, node: NodeRow): Promise<NodeRow> {
  // Absence proof must also fence lifecycle changes: claim teardown before
  // consuming proof on any node that has not already entered terminal cleanup.
  if (
    (node.runtimeTerminationConfirmedAt && node.status === 'deleted') ||
    node.status === 'destroying'
  ) {
    return await requireSameNodeIncarnation(db, node, 'managed deletion claim');
  }

  const result = await db
    .update(schema.nodes)
    .set({ status: 'destroying', healthStatus: 'stale', updatedAt: new Date().toISOString() })
    .where(exactNodeIncarnationPredicate(node))
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error(`Strict node deletion claim CAS failed: node=${node.id}`);
  }
  return await requireSameNodeIncarnation(
    db,
    { ...node, status: 'destroying', healthStatus: 'stale' },
    'managed deletion claim verification'
  );
}

/**
 * Strict node teardown for cleanup paths where hiding a failed cloud delete is
 * worse than surfacing a stale D1 row. Unlike deleteNodeResources(), this does
 * not cascade workspace status; callers must update workspace rows only after
 * external resources have actually been removed.
 */
export async function deleteNodeResourcesStrict(
  nodeId: string,
  userId: string,
  env: Env,
  options: {
    cleanupDns?: boolean;
    /** Only the explicit permanent operator deletion adapter may discard local workspace data. */
    explicitPermanentDeletion?: boolean;
    boundedStrandedRetirement?: import('./bounded-stranded-retirement-authority').BoundedStrandedRetirement;
    expectedRuntime?: StrictNodeRuntimeIdentity;
    workspaceDeletion?: ContainerWorkspaceDeletionAuthority;
    preservedVm?: PreservedVmRetirement;
    providerRequestContext?: ProviderRequestContext;
    requestDeadlineMs?: number;
    /**
     * `request`: start a provider deletion without waiting for it and return `deletion_pending`;
     * a later call confirms it from the provider's record (deadline-bounded cleanup cron only).
     * Default `wait`.
     */
    providerDeletion?: ProviderDeletionMode;
    /** How long a started deletion may stay unconfirmed before `teardown_deletion_unconfirmed`. */
    providerDeletionConfirmMaxMs?: number;
    /** Per-attempt budget of the sender; a record younger than this may still be in flight. */
    providerDeletionSendGraceMs?: number;
  } = {}
): Promise<StrictNodeDeletionResult> {
  const db = drizzle(env.DATABASE, { schema });
  let initialNode = await requireStrictNode(db, nodeId, userId);
  if (
    matchesExpectedRuntime(initialNode, options.expectedRuntime) &&
    (await recoverLegacyDeploymentBinding(env, initialNode, options.providerRequestContext?.signal))
  ) {
    initialNode = await requireStrictNode(db, nodeId, userId);
  }
  if (!matchesExpectedRuntime(initialNode, options.expectedRuntime)) {
    throw new Error(`Strict node deletion target was reincarnated before claim: node=${nodeId}`);
  }
  // The confirm phase skipped the ordinary claim guards because a deletion was already sent for
  // this runtime. If the record no longer describes it, nothing was sent for this runtime: clear
  // the record and fail, so the ordinary guarded phases decide (never a new DELETE from here).
  if (options.providerDeletion === 'confirm' && !pendingProviderDeletionFor(initialNode)) {
    await clearProviderDeletionRecord(db, initialNode, 'not_this_runtime');
    throw new Error(
      `Provider deletion record of node ${nodeId} does not describe its current runtime; cleared it`
    );
  }

  // User-owned (BYO) machines have no SAM-provisioned cloud VM: strict deletion of the cloud
  // instance is a no-op ("nothing to delete"), never a hard error, and NEVER a provider.deleteVM
  // against the user's hardware — even defensively if a providerInstanceId were somehow set.
  // Enrollment tunnels of user-owned machines are not managed here (node-tunnel-* covers
  // only SAM-provisioned managed nodes). See architecture-critique #2.
  if (isUserOwnedNodeClass(initialNode.nodeClass)) {
    return {
      providerVm: 'no-instance',
      runtimeTerminationConfirmedAt: null,
      runtimeIncarnationId: initialNode.runtimeIncarnationId,
      providerInstanceId: initialNode.providerInstanceId,
    };
  }

  if (options.workspaceDeletion && !options.expectedRuntime) {
    throw new Error('Exact container deletion requires expected runtime identity');
  }
  const beforeDestroy = options.explicitPermanentDeletion
    ? undefined
    : () =>
        requireNodeWorkspaceArtifactsDeleted(
          env,
          nodeId,
          userId,
          initialNode,
          options.workspaceDeletion,
          options.preservedVm,
          options.boundedStrandedRetirement
        );
  // A deletion already started for this exact runtime passed these guards before it was sent.
  if (!initialNode.runtimeTerminationConfirmedAt && !pendingProviderDeletionFor(initialNode)) {
    await beforeDestroy?.();
  }
  const node = await claimManagedNodeDeletion(db, initialNode);

  if (node.runtimeTerminationConfirmedAt) {
    // A providerless proof is trusted from an exact managed placement, or when the row never
    // requested a create at all: the insert-time absence proof survives only until the provider
    // identity claim, so nothing can exist at the provider (`isNeverRequestedVmPlaceholder`).
    if (
      initialNode.status === 'destroying' &&
      node.runtime === 'vm' &&
      !node.providerInstanceId &&
      !isNeverRequestedVmPlaceholder(initialNode) &&
      !hasManagedVmPlacementProof(
        initialNode,
        await isNodeCapacitySourceReleased(env.DATABASE, initialNode)
      )
    ) {
      throw new Error(`Providerless VM termination proof lacks managed placement: node=${nodeId}`);
    }
    await requireSameNodeIncarnation(db, node, 'existing termination proof use');
    if (options.cleanupDns !== false) {
      await deleteStrictNodeDnsRecord(
        node,
        userId,
        env,
        options.requestDeadlineMs,
        options.providerRequestContext?.signal
      );
    }
    await markWorkspaceRuntimeTerminationConfirmed(db, node, node.runtimeTerminationConfirmedAt);
    await releaseTerminatedNodeIngress(env, node);
    // Last, so a DNS failure holds back only the node's retirement (and the IP it clears).
    await releaseNodeAppRouteDnsRecords(env, node, options.providerRequestContext?.signal);
    return {
      providerVm: node.providerInstanceId ? 'already-absent' : 'no-instance',
      runtimeTerminationConfirmedAt: node.runtimeTerminationConfirmedAt,
      runtimeIncarnationId: node.runtimeIncarnationId,
      providerInstanceId: node.providerInstanceId,
    };
  }

  if (node.runtime === 'cf-container') {
    await requireSameNodeIncarnation(db, node, 'container teardown');
    await beforeDestroy?.();
    await destroyVmAgentContainer(env, node.id);
    const runtimeTerminationConfirmedAt = await markRuntimeTerminationConfirmed(db, node);
    if (options.cleanupDns !== false) {
      await deleteStrictNodeDnsRecord(
        node,
        userId,
        env,
        options.requestDeadlineMs,
        options.providerRequestContext?.signal
      );
    }
    // No-op today (only VM deployment nodes serve app routes); kept so every proof branch runs it.
    await releaseNodeAppRouteDnsRecords(env, node, options.providerRequestContext?.signal);
    return {
      providerVm: 'no-instance',
      runtimeTerminationConfirmedAt,
      runtimeIncarnationId: node.runtimeIncarnationId,
      providerInstanceId: node.providerInstanceId,
    };
  }

  // Before the provider deletion: once the VM is gone the provider may reassign its IP, so the
  // app-route records pointing at it must go while SAM still holds it. The claim above has made
  // the node `destroying`, so they judge as released. A failure throws here, leaving the VM (and
  // its IP) in place and the node retryable; nothing has been deleted at the provider yet.
  await releaseNodeAppRouteDnsRecords(env, node, options.providerRequestContext?.signal);
  let providerVm: StrictNodeDeletionResult['providerVm'];
  try {
    providerVm =
      initialNode.status === 'destroying' && node.runtime === 'vm' && !node.providerInstanceId
        ? await reconcileStrictProviderlessVm(
            db,
            node,
            userId,
            env,
            options.providerRequestContext,
            beforeDestroy
          )
        : await deleteStrictProviderInstance(
            db,
            node,
            userId,
            env,
            {
              mode: options.providerDeletion ?? 'wait',
              confirmMaxMs:
                options.providerDeletionConfirmMaxMs ??
                DEFAULT_NODE_PROVIDER_DELETION_CONFIRM_MAX_MS,
              sendGraceMs:
                options.providerDeletionSendGraceMs ??
                DEFAULT_NODE_PROVIDER_DELETION_REQUEST_TIMEOUT_MS,
            },
            options.providerRequestContext,
            beforeDestroy
          );
  } catch (error) {
    // Every entry point (owner delete, NodeLifecycle stop, cleanup cron, deployment and
    // TaskRunner cleanup) funnels through here, so a named refusal is recorded once, visibly.
    if (error instanceof NodeTeardownBlockedError) {
      await recordNodeTeardownBlocked(env, node, error);
    }
    throw error;
  }
  if (providerVm === 'deletion_pending') {
    // No proof: the provider has not confirmed the deletion yet.
    return {
      providerVm,
      runtimeTerminationConfirmedAt: null,
      runtimeIncarnationId: node.runtimeIncarnationId,
      providerInstanceId: node.providerInstanceId,
    };
  }
  const runtimeTerminationConfirmedAt = await markRuntimeTerminationConfirmed(db, node);
  // The proof makes this incarnation non-live, which releases its Cloudflare tunnel (if it
  // had one). Never throws: the tunnel journal keeps the identity for the cron sweep.
  await releaseTerminatedNodeIngress(env, node);
  if (options.cleanupDns !== false) {
    await deleteStrictNodeDnsRecord(
      node,
      userId,
      env,
      options.requestDeadlineMs,
      options.providerRequestContext?.signal
    );
  }
  return {
    providerVm,
    runtimeTerminationConfirmedAt,
    runtimeIncarnationId: node.runtimeIncarnationId,
    providerInstanceId: node.providerInstanceId,
  };
}
