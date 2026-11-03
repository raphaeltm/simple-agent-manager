import { ProviderError } from '@simple-agent-manager/providers';
import { type CredentialProvider, isUserOwnedNodeClass } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { errors } from '../middleware/error';
import {
  createProviderForUser,
  exactProviderCredentialBindingFromPlacementSnapshot,
} from './provider-credentials';
import { recordOwnerAttestedRuntimeTermination } from './strict-node-deletion';

type NodeDb = ReturnType<typeof drizzle<typeof schema>>;
type NodeRow = typeof schema.nodes.$inferSelect;

/** States a node is left in after SAM's own teardown attempt failed. */
const MANUAL_DELETION_NODE_STATUSES = ['destroying', 'deleting', 'error'];

export interface ManualNodeDeletionProof {
  node: NodeRow;
  runtimeTerminationConfirmedAt: string;
}

/**
 * Any of the three credential columns can say the server was paid for with SAM's own
 * credential: Instant nodes set only `credentialAttributionSource`
 * (`services/instant-session.ts`), capacity placement sets
 * `placementCredentialSource`, older nodes set `credentialSource`.
 */
function isOnSamCapacity(node: NodeRow): boolean {
  return (
    node.credentialSource === 'platform' ||
    node.placementCredentialSource === 'platform' ||
    node.credentialAttributionSource === 'platform'
  );
}

/**
 * Asks the provider whether the server still exists. Only a returned server is
 * evidence it exists. A credential SAM cannot resolve, or one the provider
 * rejects, cannot see the server either way: that is the legacy mis-bound case
 * this escape exists for, so it proceeds on the owner's word. Any other lookup
 * failure leaves the answer unknown, and the owner is asked to retry instead.
 */
async function providerStillHasServer(db: NodeDb, env: Env, node: NodeRow): Promise<boolean> {
  const targetProvider = node.cloudProvider as CredentialProvider | null;
  if (!node.providerInstanceId || !targetProvider) return false;
  let providerResult: Awaited<ReturnType<typeof createProviderForUser>>;
  try {
    providerResult = await createProviderForUser(
      db,
      node.credentialAttributionUserId ?? node.userId,
      getCredentialEncryptionKey(env),
      env,
      targetProvider,
      node.credentialAttributionSource === 'project'
        ? (node.credentialAttributionProjectId ?? null)
        : null,
      exactProviderCredentialBindingFromPlacementSnapshot(node) ?? undefined
    );
  } catch (error) {
    log.warn('node_manual_deletion.provider_credential_unavailable', {
      nodeId: node.id,
      provider: targetProvider,
      error: serializeError(error),
    });
    return false;
  }
  if (!providerResult || providerResult.providerName !== targetProvider) return false;
  try {
    return (await providerResult.provider.getVM(node.providerInstanceId)) !== null;
  } catch (error) {
    if (isCredentialRejection(error)) {
      log.warn('node_manual_deletion.provider_credential_rejected', {
        nodeId: node.id,
        provider: targetProvider,
        error: serializeError(error),
      });
      return false;
    }
    log.warn('node_manual_deletion.provider_check_unavailable', {
      nodeId: node.id,
      provider: targetProvider,
      error: serializeError(error),
    });
    throw errors.serviceUnavailable(
      `Could not check with ${targetProvider} whether server ${node.providerInstanceId} still exists. Try again in a minute.`
    );
  }
}

/**
 * The provider refused this credential, so it can never answer for this server.
 * 401 and 403 are the only statuses that mean that; the categorised `auth_error`
 * covers providers that report it without a status. Rate limits, capacity and
 * server errors are temporary, so they are not included (rule 72).
 */
function isCredentialRejection(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return error.statusCode === 401 || error.statusCode === 403 || error.category === 'auth_error';
}

/**
 * Records the owner's statement that they deleted a node's server by hand, after
 * SAM's strict teardown failed (for example a node placed before SAM recorded the
 * credential binding strict deletion now requires). Strict deletion fails closed
 * for those nodes and retries forever, so this is their escape path
 * (`.claude/rules/71`, idea 01M6DFJTV3VCFEJEBYMK3KYF7A).
 */
export async function recordManualNodeDeletion(
  db: NodeDb,
  env: Env,
  nodeId: string,
  userId: string
): Promise<ManualNodeDeletionProof> {
  const [node] = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);
  if (!node) throw errors.notFound('Node');
  if (isUserOwnedNodeClass(node.nodeClass)) {
    throw errors.conflict('This machine is registered by you; remove it with Delete instead');
  }
  if (!MANUAL_DELETION_NODE_STATUSES.includes(node.status)) {
    throw errors.conflict(
      'Only a node SAM failed to delete can be removed manually. Try Delete first.'
    );
  }
  if (node.runtime !== 'vm') {
    // A container runtime has no provider server the owner could have deleted, and
    // the provider check below cannot see it (Instant nodes have no instance id).
    throw errors.forbidden('Only a cloud server can be removed this way; contact an operator');
  }
  if (isOnSamCapacity(node)) {
    // The server lives in SAM's own cloud account, so the owner cannot have removed it.
    throw errors.forbidden('This server runs on SAM-managed capacity; contact an operator');
  }
  if (await providerStillHasServer(db, env, node)) {
    throw errors.conflict(
      `Server ${node.providerInstanceId} still exists at ${node.cloudProvider}. ` +
        'Delete it there first, then try again.'
    );
  }
  const runtimeTerminationConfirmedAt = await recordOwnerAttestedRuntimeTermination(db, node);
  log.info('node_manual_deletion.attested', {
    nodeId,
    userId,
    nodeRole: node.nodeRole,
    previousStatus: node.status,
    provider: node.cloudProvider,
    providerInstanceId: node.providerInstanceId,
  });
  return { node, runtimeTerminationConfirmedAt };
}
