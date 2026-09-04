import {
  CREDENTIAL_PROVIDERS,
  type CredentialProvider,
  isUserOwnedNodeClass,
} from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { deleteDNSRecord } from './dns';
import { persistError } from './observability';
import {
  createProviderForUser,
  exactProviderCredentialBindingFromPlacementSnapshot,
} from './provider-credentials';
import { destroyVmAgentContainer } from './vm-agent-container';

type NodeDb = ReturnType<typeof drizzle<typeof schema>>;
type NodeRow = typeof schema.nodes.$inferSelect;
type ProviderForUserResult = NonNullable<Awaited<ReturnType<typeof createProviderForUser>>>;

const NODE_INCARNATION_KEYS = [
  'userId',
  'status',
  'nodeClass',
  'runtime',
  'providerInstanceId',
  'cloudProvider',
  'credentialSource',
  'credentialAttributionUserId',
  'credentialAttributionProjectId',
  'credentialAttributionSource',
  'capacityPoolId',
  'capacityPoolScope',
  'capacityPoolRevision',
  'capacitySourceId',
  'capacityPoolCandidateId',
  'placementCredentialSource',
  'placementCredentialReference',
  'placementCredentialVersion',
  'capacityPoolProjectId',
  'workloadRole',
  'providerInstanceType',
  'runtimeTerminationConfirmedAt',
] as const satisfies readonly (keyof NodeRow)[];

function isSameNodeIncarnation(current: NodeRow, expected: NodeRow): boolean {
  return NODE_INCARNATION_KEYS.every((key) => (current[key] ?? null) === (expected[key] ?? null));
}

function exactNodeIncarnationPredicate(node: NodeRow) {
  // SQLite IS is deliberately used for nullable snapshot columns. This is the
  // compare-and-set fence that binds termination proof to one exact runtime and
  // credential placement, without logging credential references.
  return and(
    eq(schema.nodes.id, node.id),
    sql`${schema.nodes.userId} IS ${node.userId}`,
    sql`${schema.nodes.status} IS ${node.status}`,
    sql`${schema.nodes.nodeClass} IS ${node.nodeClass}`,
    sql`${schema.nodes.runtime} IS ${node.runtime}`,
    sql`${schema.nodes.providerInstanceId} IS ${node.providerInstanceId}`,
    sql`${schema.nodes.cloudProvider} IS ${node.cloudProvider}`,
    sql`${schema.nodes.credentialSource} IS ${node.credentialSource}`,
    sql`${schema.nodes.credentialAttributionUserId} IS ${node.credentialAttributionUserId}`,
    sql`${schema.nodes.credentialAttributionProjectId} IS ${node.credentialAttributionProjectId}`,
    sql`${schema.nodes.credentialAttributionSource} IS ${node.credentialAttributionSource}`,
    sql`${schema.nodes.capacityPoolId} IS ${node.capacityPoolId}`,
    sql`${schema.nodes.capacityPoolScope} IS ${node.capacityPoolScope}`,
    sql`${schema.nodes.capacityPoolRevision} IS ${node.capacityPoolRevision}`,
    sql`${schema.nodes.capacitySourceId} IS ${node.capacitySourceId}`,
    sql`${schema.nodes.capacityPoolCandidateId} IS ${node.capacityPoolCandidateId}`,
    sql`${schema.nodes.placementCredentialSource} IS ${node.placementCredentialSource}`,
    sql`${schema.nodes.placementCredentialReference} IS ${node.placementCredentialReference}`,
    sql`${schema.nodes.placementCredentialVersion} IS ${node.placementCredentialVersion}`,
    sql`${schema.nodes.capacityPoolProjectId} IS ${node.capacityPoolProjectId}`,
    sql`${schema.nodes.workloadRole} IS ${node.workloadRole}`,
    sql`${schema.nodes.providerInstanceType} IS ${node.providerInstanceType}`,
    sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${node.runtimeTerminationConfirmedAt}`
  );
}

async function requireStrictNode(db: NodeDb, nodeId: string, userId: string): Promise<NodeRow> {
  const rows = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);

  const node = rows[0];
  if (!node) {
    throw new Error(`Node ${nodeId} not found for strict deletion`);
  }
  return node;
}

async function requireSameNodeIncarnation(
  db: NodeDb,
  expected: NodeRow,
  phase: string
): Promise<NodeRow> {
  const current = await requireStrictNode(db, expected.id, expected.userId);
  if (!isSameNodeIncarnation(current, expected)) {
    throw new Error(
      `Strict node deletion lost its incarnation fence before ${phase}: node=${expected.id}`
    );
  }
  return current;
}

function getStrictNodeCredentialContext(node: NodeRow, userId: string) {
  const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
  const attributionUserId = node.credentialAttributionUserId ?? userId;
  const attributionProjectId =
    node.credentialAttributionSource === 'project'
      ? (node.credentialAttributionProjectId ?? null)
      : null;
  const exactCredential = exactProviderCredentialBindingFromPlacementSnapshot(node);
  return { targetProvider, attributionUserId, attributionProjectId, exactCredential };
}

async function requireStrictNodeProvider(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<ProviderForUserResult> {
  const { targetProvider, attributionUserId, attributionProjectId, exactCredential } =
    getStrictNodeCredentialContext(node, userId);
  const providerResult = await createProviderForUser(
    db,
    attributionUserId,
    getCredentialEncryptionKey(env),
    env,
    targetProvider,
    attributionProjectId,
    exactCredential
  );
  if (!providerResult) {
    throw new Error(
      `Cloud provider credentials missing for strict node deletion: node=${node.id} provider=${node.cloudProvider ?? 'unknown'} instance=${node.providerInstanceId}`
    );
  }
  return providerResult;
}

type StrictProviderResolution =
  | { state: 'present'; providerResult: ProviderForUserResult }
  | { state: 'absent'; providersChecked: CredentialProvider[] };

async function resolveStrictNodeProvider(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<StrictProviderResolution> {
  const providerInstanceId = node.providerInstanceId;
  if (!providerInstanceId) {
    throw new Error(`Cannot strictly resolve provider for node ${node.id}: instance ID is missing`);
  }
  const { targetProvider, attributionUserId, attributionProjectId, exactCredential } =
    getStrictNodeCredentialContext(node, userId);

  if (targetProvider) {
    const providerResult = await requireStrictNodeProvider(db, node, userId, env);
    if (providerResult.providerName !== targetProvider) {
      throw new Error(
        `Cannot strictly delete node ${node.id}: requested provider ${targetProvider} resolved as ${providerResult.providerName}`
      );
    }
    return { state: 'present', providerResult };
  }

  if (exactCredential) {
    throw new Error(
      `Cannot strictly delete node ${node.id}: exact credential snapshot requires a persisted cloud provider`
    );
  }

  const candidates: ProviderForUserResult[] = [];
  for (const providerName of CREDENTIAL_PROVIDERS) {
    const providerResult = await createProviderForUser(
      db,
      attributionUserId,
      getCredentialEncryptionKey(env),
      env,
      providerName,
      attributionProjectId
    );
    if (!providerResult) continue;
    if (providerResult.providerName !== providerName) {
      throw new Error(
        `Cannot strictly delete node ${node.id}: requested provider ${providerName} resolved as ${providerResult.providerName}`
      );
    }
    candidates.push(providerResult);
  }

  if (candidates.length === 0) {
    throw new Error(
      `Cloud provider credentials missing for strict node deletion: node=${node.id} provider=unknown instance=${node.providerInstanceId}`
    );
  }

  const presentCandidates: ProviderForUserResult[] = [];
  for (const candidate of candidates) {
    await requireSameNodeIncarnation(db, node, `${candidate.providerName} provider lookup`);
    const vm = await candidate.provider.getVM(providerInstanceId);
    await requireSameNodeIncarnation(db, node, `${candidate.providerName} provider lookup result`);
    if (vm === null) continue;
    if (!vm || typeof vm !== 'object') {
      throw new Error(
        `Cannot strictly delete node ${node.id}: ambiguous ${candidate.providerName} lookup result`
      );
    }
    presentCandidates.push(candidate);
  }

  if (presentCandidates.length > 1) {
    throw new Error(
      `Cannot strictly delete node ${node.id}: instance ${node.providerInstanceId} matched multiple providers`
    );
  }

  const providerResult = presentCandidates[0];
  return providerResult
    ? { state: 'present', providerResult }
    : { state: 'absent', providersChecked: candidates.map((candidate) => candidate.providerName) };
}

export type StrictNodeDeletionResult = { providerVm: 'no-instance' | 'deleted' | 'already-absent' };

async function deleteStrictProviderInstance(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<StrictNodeDeletionResult['providerVm']> {
  if (!node.providerInstanceId) {
    throw new Error(
      `Cannot confirm managed VM termination for node ${node.id}: instance identity is missing`
    );
  }

  const providerResolution = await resolveStrictNodeProvider(db, node, userId, env);

  if (providerResolution.state === 'absent') {
    log.warn('node_delete.strict_provider_vm_already_absent', {
      nodeId: node.id,
      providersChecked: providerResolution.providersChecked,
      providerInstanceId: node.providerInstanceId,
    });
    return 'already-absent';
  }

  const { providerResult } = providerResolution;

  await requireSameNodeIncarnation(db, node, 'provider delete');
  await providerResult.provider.deleteVM(node.providerInstanceId);
  return 'deleted';
}

async function persistStrictDnsCleanupError(
  env: Env,
  input: {
    nodeId: string;
    userId: string;
    backendDnsRecordId: string;
    err: unknown;
  }
): Promise<void> {
  await persistError(
    env.OBSERVABILITY_DATABASE,
    {
      source: 'api',
      level: 'error',
      message: `Strict node DNS cleanup failed: ${input.err instanceof Error ? input.err.message : String(input.err)}`,
      stack: input.err instanceof Error ? input.err.stack : undefined,
      context: {
        component: 'node-deletion',
        recoveryType: 'strict_node_dns_cleanup_failure',
        nodeId: input.nodeId,
        backendDnsRecordId: input.backendDnsRecordId,
      },
      nodeId: input.nodeId,
      userId: input.userId,
    },
    env
  );
}

async function deleteStrictNodeDnsRecord(node: NodeRow, userId: string, env: Env): Promise<void> {
  if (!node.backendDnsRecordId) return;

  try {
    await deleteDNSRecord(node.backendDnsRecordId, env);
  } catch (err) {
    log.error('node_delete.strict_dns_cleanup_failed', { nodeId: node.id, ...serializeError(err) });
    try {
      await persistStrictDnsCleanupError(env, {
        nodeId: node.id,
        userId,
        backendDnsRecordId: node.backendDnsRecordId,
        err,
      });
    } catch (obsErr) {
      log.error('node_delete.strict_dns_observability_failed', {
        nodeId: node.id,
        ...serializeError(obsErr),
      });
    }
  }
}

async function markWorkspaceRuntimeTerminationConfirmed(
  db: NodeDb,
  node: NodeRow,
  confirmedAt: string
): Promise<void> {
  await db
    .update(schema.workspaces)
    .set({
      status: 'deleted',
      errorMessage: null,
      runtimeDeletionConfirmedAt: confirmedAt,
      runtimeDeletionProof: 'node_runtime_terminated',
      updatedAt: confirmedAt,
    })
    .where(
      and(
        eq(schema.workspaces.nodeId, node.id),
        eq(schema.workspaces.userId, node.userId),
        sql`EXISTS (
          SELECT 1
            FROM nodes AS proof_node
           WHERE proof_node.id = ${node.id}
             AND proof_node.user_id IS ${node.userId}
             AND proof_node.status IS ${node.status}
             AND proof_node.runtime IS ${node.runtime}
             AND proof_node.provider_instance_id IS ${node.providerInstanceId}
             AND proof_node.runtime_termination_confirmed_at IS ${confirmedAt}
        )`
      )
    );
}

async function markRuntimeTerminationConfirmed(db: NodeDb, node: NodeRow): Promise<void> {
  await requireSameNodeIncarnation(db, node, 'termination proof write');
  const confirmedAt = new Date().toISOString();
  const result = await db
    .update(schema.nodes)
    .set({
      runtimeTerminationConfirmedAt: confirmedAt,
    })
    .where(exactNodeIncarnationPredicate(node))
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error(`Strict node deletion proof CAS failed: node=${node.id}`);
  }
  await requireSameNodeIncarnation(
    db,
    { ...node, runtimeTerminationConfirmedAt: confirmedAt },
    'termination proof verification'
  );
  await markWorkspaceRuntimeTerminationConfirmed(db, node, confirmedAt);
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
  options: { cleanupDns?: boolean } = {}
): Promise<StrictNodeDeletionResult> {
  const db = drizzle(env.DATABASE, { schema });
  const node = await requireStrictNode(db, nodeId, userId);

  // User-owned (BYO) machines have no SAM-provisioned cloud VM: strict deletion of the cloud
  // instance is a no-op ("nothing to delete"), never a hard error, and NEVER a provider.deleteVM
  // against the user's hardware — even defensively if a providerInstanceId were somehow set.
  // The tunnel CNAME teardown lands in Phase 1. See architecture-critique #2.
  if (isUserOwnedNodeClass(node.nodeClass)) {
    return { providerVm: 'no-instance' };
  }

  if (node.runtimeTerminationConfirmedAt) {
    await requireSameNodeIncarnation(db, node, 'existing termination proof use');
    await markWorkspaceRuntimeTerminationConfirmed(db, node, node.runtimeTerminationConfirmedAt);
    return { providerVm: node.providerInstanceId ? 'already-absent' : 'no-instance' };
  }

  if (node.runtime === 'cf-container') {
    await requireSameNodeIncarnation(db, node, 'container teardown');
    await destroyVmAgentContainer(env, node.id);
    await markRuntimeTerminationConfirmed(db, node);
    if (options.cleanupDns !== false) await deleteStrictNodeDnsRecord(node, userId, env);
    return { providerVm: 'no-instance' };
  }

  const providerVm = await deleteStrictProviderInstance(db, node, userId, env);
  await markRuntimeTerminationConfirmed(db, node);
  if (options.cleanupDns !== false) await deleteStrictNodeDnsRecord(node, userId, env);
  return { providerVm };
}
