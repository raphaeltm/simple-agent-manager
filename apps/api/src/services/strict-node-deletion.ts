import { CREDENTIAL_PROVIDERS, type CredentialProvider } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { deleteDNSRecord } from './dns';
import { persistError } from './observability';
import { createProviderForUser } from './provider-credentials';

type NodeDb = ReturnType<typeof drizzle<typeof schema>>;
type NodeRow = typeof schema.nodes.$inferSelect;
type ProviderForUserResult = NonNullable<Awaited<ReturnType<typeof createProviderForUser>>>;

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

function getStrictNodeCredentialContext(node: NodeRow, userId: string) {
  const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
  const attributionUserId = node.credentialAttributionUserId ?? userId;
  const attributionProjectId =
    node.credentialAttributionSource === 'project'
      ? (node.credentialAttributionProjectId ?? null)
      : null;
  return { targetProvider, attributionUserId, attributionProjectId };
}

async function requireStrictNodeProvider(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<ProviderForUserResult> {
  const { targetProvider, attributionUserId, attributionProjectId } =
    getStrictNodeCredentialContext(node, userId);
  const providerResult = await createProviderForUser(
    db,
    attributionUserId,
    getCredentialEncryptionKey(env),
    env,
    targetProvider,
    attributionProjectId
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
  const { targetProvider, attributionUserId, attributionProjectId } =
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
    const vm = await candidate.provider.getVM(providerInstanceId);
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
  if (!node.providerInstanceId) return 'no-instance';

  const credentialContext = getStrictNodeCredentialContext(node, userId);
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

  await db
    .update(schema.nodes)
    .set({
      cloudProvider: providerResult.providerName,
      credentialSource: providerResult.credentialSource,
      credentialAttributionUserId: credentialContext.attributionUserId,
      credentialAttributionProjectId:
        providerResult.credentialSource === 'project'
          ? credentialContext.attributionProjectId
          : null,
      credentialAttributionSource: providerResult.credentialSource,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.nodes.id, node.id));

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
  await persistError(env.OBSERVABILITY_DATABASE, {
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
  });
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

/**
 * Strict node teardown for cleanup paths where hiding a failed cloud delete is
 * worse than surfacing a stale D1 row. Unlike deleteNodeResources(), this does
 * not cascade workspace status; callers must update workspace rows only after
 * external resources have actually been removed.
 */
export async function deleteNodeResourcesStrict(
  nodeId: string,
  userId: string,
  env: Env
): Promise<StrictNodeDeletionResult> {
  const db = drizzle(env.DATABASE, { schema });
  const node = await requireStrictNode(db, nodeId, userId);

  const providerVm = await deleteStrictProviderInstance(db, node, userId, env);
  await deleteStrictNodeDnsRecord(node, userId, env);
  return { providerVm };
}
