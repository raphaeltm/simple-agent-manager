/**
 * Incarnation fences and exact provider resolution shared by strict node teardown.
 * Split out of `strict-node-deletion.ts` (rule 18); behavior unchanged.
 */
import { type CredentialProvider } from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import {
  hasExactProviderCredentialGenerationProof,
  isExactCredentialSource,
} from './provider-credential-exact';
import {
  createProviderForUser,
  type ExactProviderCredentialBinding,
  exactProviderCredentialBindingFromPlacementSnapshot,
} from './provider-credentials';

export type NodeDb = ReturnType<typeof drizzle<typeof schema>>;
export type NodeRow = typeof schema.nodes.$inferSelect;
export type ProviderForUserResult = NonNullable<Awaited<ReturnType<typeof createProviderForUser>>>;

export const NODE_INCARNATION_KEYS = [
  'userId',
  'status',
  'nodeClass',
  'runtime',
  'providerInstanceId',
  'runtimeIncarnationId',
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
  'placementCredentialFingerprint',
  'capacityPoolProjectId',
  'workloadRole',
  'providerInstanceType',
  'runtimeTerminationConfirmedAt',
] as const satisfies readonly (keyof NodeRow)[];

export function isSameNodeIncarnation(current: NodeRow, expected: NodeRow): boolean {
  return NODE_INCARNATION_KEYS.every((key) => (current[key] ?? null) === (expected[key] ?? null));
}

export function exactNodeIncarnationPredicate(node: NodeRow) {
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
    sql`${schema.nodes.runtimeIncarnationId} IS ${node.runtimeIncarnationId}`,
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
    sql`${schema.nodes.placementCredentialFingerprint} IS ${node.placementCredentialFingerprint}`,
    sql`${schema.nodes.capacityPoolProjectId} IS ${node.capacityPoolProjectId}`,
    sql`${schema.nodes.workloadRole} IS ${node.workloadRole}`,
    sql`${schema.nodes.providerInstanceType} IS ${node.providerInstanceType}`,
    sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${node.runtimeTerminationConfirmedAt}`
  );
}

export async function requireStrictNode(
  db: NodeDb,
  nodeId: string,
  userId: string
): Promise<NodeRow> {
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

export async function requireSameNodeIncarnation(
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

export function getStrictNodeCredentialContext(node: NodeRow, userId: string) {
  const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
  const attributionUserId = node.credentialAttributionUserId ?? userId;
  const attributionProjectId =
    node.credentialAttributionSource === 'project'
      ? (node.credentialAttributionProjectId ?? null)
      : null;
  const exactCredential = exactProviderCredentialBindingFromPlacementSnapshot(node);
  return { targetProvider, attributionUserId, attributionProjectId, exactCredential };
}
export function hasManagedVmPlacementProof(node: NodeRow): boolean {
  const hasText = (value: string | null): boolean => !!value?.trim();
  return (
    ['workspace', 'deployment'].includes(node.nodeRole) &&
    node.nodeClass === 'managed' &&
    node.runtime === 'vm' &&
    node.workloadRole === node.nodeRole &&
    ['user', 'project', 'installation'].includes(node.capacityPoolScope ?? '') &&
    (node.capacityPoolScope !== 'project' || hasText(node.capacityPoolProjectId)) &&
    (node.capacityPoolScope === 'project' || !node.capacityPoolProjectId) &&
    (node.capacityPoolRevision ?? 0) > 0 &&
    (node.capacitySourceGeneration ?? 0) > 0 &&
    isExactCredentialSource(node.placementCredentialSource) &&
    (node.placementCredentialVersion ?? 0) > 0 &&
    (node.providerInstanceVcpuCount ?? 0) > 0 &&
    (node.providerInstanceMemoryMb ?? 0) > 0 &&
    hasText(node.capacityPoolId) &&
    hasText(node.capacitySourceId) &&
    hasText(node.capacityPoolCandidateId) &&
    hasText(node.placementCredentialReference) &&
    hasText(node.placementCredentialFingerprint) &&
    hasText(node.cloudProvider) &&
    hasText(node.providerInstanceType)
  );
}

/**
 * Name the absent prerequisites without echoing their values. Credential references are
 * IDs rather than secrets, but strict teardown deliberately keeps them out of logs and
 * error strings, so this reports which fields are missing and never what they contain.
 */
export function describeMissingExactBinding(
  node: NodeRow,
  targetProvider: CredentialProvider | undefined,
  exactCredential: ExactProviderCredentialBinding | null
): string {
  const missing: string[] = [];
  if (!targetProvider) missing.push('cloudProvider');
  if (!exactCredential) {
    // A null binding means the snapshot was rejected, which happens for either an invalid
    // source OR an absent reference. Report only the field that actually failed — reading
    // the raw columns rather than inferring from the null. Collapsing two distinct absent
    // states into one label is the exact defect this whole change exists to fix, and it
    // would send an operator looking at the wrong column.
    if (!isExactCredentialSource(node.placementCredentialSource)) {
      missing.push('placementCredentialSource');
    }
    if (!node.placementCredentialReference) missing.push('placementCredentialReference');
  } else if (!hasExactProviderCredentialGenerationProof(exactCredential)) {
    // A non-null binding always carries a truthy reference, so the only remaining
    // absence at this point is the generation proof.
    missing.push('placementCredentialFingerprint and placementCredentialVersion');
  }
  return missing.join(', ');
}

export async function requireStrictNodeProvider(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<ProviderForUserResult> {
  const { targetProvider, attributionUserId, attributionProjectId, exactCredential } =
    getStrictNodeCredentialContext(node, userId);
  // A fingerprint is the preferred generation proof, but requiring it outright strands every
  // node provisioned before migration 0142 — that column is backfill-proof, so those rows can
  // never satisfy it. `hasExactProviderCredentialGenerationProof` also accepts the weaker
  // version snapshot those nodes were placed with; `exactCredentialGenerationMatches` still
  // refuses a rotated credential on either path, so this stays fail-closed.
  if (!targetProvider || !hasExactProviderCredentialGenerationProof(exactCredential)) {
    throw new Error(
      `Cannot strictly delete node ${node.id}: exact provider credential binding is missing ` +
        `(${describeMissingExactBinding(node, targetProvider, exactCredential)})`
    );
  }
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

export async function resolveStrictNodeProvider(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<ProviderForUserResult> {
  if (!node.providerInstanceId) {
    throw new Error(`Cannot strictly resolve provider for node ${node.id}: instance ID is missing`);
  }
  const targetProvider = node.cloudProvider as CredentialProvider | null;
  const providerResult = await requireStrictNodeProvider(db, node, userId, env);
  if (!targetProvider || providerResult.providerName !== targetProvider) {
    throw new Error(
      `Cannot strictly delete node ${node.id}: persisted provider binding did not resolve exactly`
    );
  }
  return providerResult;
}
