import {
  hasAmbiguousLabel,
  type VMInstance,
} from '@simple-agent-manager/providers';
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import { exactProviderCredentialBindingFromPlacementSnapshot } from './provider-credential-exact';
import { createProviderForUser } from './provider-credentials';

type NodeRow = typeof schema.nodes.$inferSelect;
type ReconciliationDb = ReturnType<typeof drizzle<typeof schema>>;

export type ProviderAbsenceReconciliationStatus =
  | 'absent_observed'
  | 'absent_confirmed'
  | 'already_confirmed'
  | 'exact_match_present';

export interface SanitizedProviderVm {
  id: string;
  name: string;
  status: string;
  location: string | null;
  serverType: string;
  createdAt: string;
  labels: Record<string, string>;
}

export interface ProviderAbsenceReconciliationResult {
  status: ProviderAbsenceReconciliationStatus;
  nodeId: string;
  userId: string;
  provider: string;
  credentialSource: string | null;
  credentialReference: string | null;
  runtimeIncarnationId: string | null;
  runtimeTerminationConfirmedAt: string | null;
  labels: Record<string, string>;
  providerReturned: number;
  exactMatches: SanitizedProviderVm[];
  nonExactReturned: SanitizedProviderVm[];
}

export class ProviderAbsenceReconciliationError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'not_reconcilable' | 'credential_unavailable' | 'cas_failed'
  ) {
    super(message);
    this.name = 'ProviderAbsenceReconciliationError';
  }
}

function sanitizedVm(vm: VMInstance): SanitizedProviderVm {
  return {
    id: vm.id,
    name: vm.name,
    status: vm.status,
    location: vm.location ?? null,
    serverType: vm.serverType,
    createdAt: vm.createdAt,
    labels: { ...vm.labels },
  };
}

function exactLabelMatch(vm: VMInstance, labels: Record<string, string>): boolean {
  return Object.entries(labels).every(
    ([key, value]) => !hasAmbiguousLabel(vm.labels, key) && vm.labels[key] === value
  );
}

function requireManagedVmWithoutProviderId(node: NodeRow): void {
  if (node.nodeClass !== 'managed' || node.runtime !== 'vm') {
    throw new ProviderAbsenceReconciliationError(
      `Node ${node.id} is not a managed VM node`,
      'not_reconcilable'
    );
  }
  if (node.providerInstanceId) {
    throw new ProviderAbsenceReconciliationError(
      `Node ${node.id} already has provider instance ${node.providerInstanceId}`,
      'not_reconcilable'
    );
  }
  if (!node.cloudProvider) {
    throw new ProviderAbsenceReconciliationError(
      `Node ${node.id} has no cloud provider binding`,
      'not_reconcilable'
    );
  }
  if (!node.runtimeIncarnationId) {
    throw new ProviderAbsenceReconciliationError(
      `Node ${node.id} has no runtime incarnation id`,
      'not_reconcilable'
    );
  }
}

async function loadNode(db: ReconciliationDb, nodeId: string): Promise<NodeRow> {
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId)).limit(1);
  if (!node) {
    throw new ProviderAbsenceReconciliationError(`Node ${nodeId} not found`, 'not_found');
  }
  return node;
}

async function resolveExactProvider(db: ReconciliationDb, env: Env, node: NodeRow) {
  const exactCredential = exactProviderCredentialBindingFromPlacementSnapshot(node);
  if (!exactCredential) {
    throw new ProviderAbsenceReconciliationError(
      `Node ${node.id} has no exact placement credential snapshot`,
      'credential_unavailable'
    );
  }
  const attributionUserId = node.credentialAttributionUserId ?? node.userId;
  const attributionProjectId =
    node.credentialAttributionSource === 'project'
      ? (node.credentialAttributionProjectId ?? null)
      : null;
  const provider = await createProviderForUser(
    db,
    attributionUserId,
    getCredentialEncryptionKey(env),
    env,
    node.cloudProvider as CredentialProvider,
    attributionProjectId,
    exactCredential
  );
  if (!provider) {
    throw new ProviderAbsenceReconciliationError(
      `Exact provider credential for node ${node.id} could not be resolved`,
      'credential_unavailable'
    );
  }
  return provider;
}

function buildExactLabels(env: Env, node: NodeRow): Record<string, string> {
  const installationId = resolveInstallationId(env);
  const environmentLabel = resolveEnvironmentLabel(env);
  if (!installationId || !environmentLabel) {
    throw new ProviderAbsenceReconciliationError(
      `Provider ownership scope is unavailable for node ${node.id}`,
      'not_reconcilable'
    );
  }
  return buildNodeProviderLabels({
    nodeId: node.id,
    isDeploymentNode: (node.nodeRole ?? 'workspace') === 'deployment',
    installationId,
    environmentLabel,
    runtimeIncarnationId: node.runtimeIncarnationId ?? undefined,
  });
}

async function markRuntimeTerminationConfirmed(
  db: ReconciliationDb,
  node: NodeRow,
  observedAt: string
): Promise<void> {
  const result = await db
    .update(schema.nodes)
    .set({ runtimeTerminationConfirmedAt: observedAt, updatedAt: observedAt })
    .where(
      and(
        eq(schema.nodes.id, node.id),
        eq(schema.nodes.userId, node.userId),
        eq(schema.nodes.nodeClass, 'managed'),
        eq(schema.nodes.runtime, 'vm'),
        eq(schema.nodes.status, node.status),
        isNull(schema.nodes.providerInstanceId),
        sql`${schema.nodes.runtimeIncarnationId} IS ${node.runtimeIncarnationId}`,
        sql`${schema.nodes.runtimeTerminationConfirmedAt} IS NULL`,
        sql`${schema.nodes.placementCredentialSource} IS ${node.placementCredentialSource}`,
        sql`${schema.nodes.placementCredentialReference} IS ${node.placementCredentialReference}`,
        sql`${schema.nodes.placementCredentialVersion} IS ${node.placementCredentialVersion}`,
        sql`${schema.nodes.placementCredentialFingerprint} IS ${node.placementCredentialFingerprint}`
      )
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ProviderAbsenceReconciliationError(
      `Node ${node.id} changed before provider absence proof could be recorded`,
      'cas_failed'
    );
  }
}

export async function reconcileNodeProviderAbsence(
  env: Env,
  input: {
    nodeId: string;
    confirmAbsence: boolean;
    expectedRuntimeIncarnationId?: string;
  }
): Promise<ProviderAbsenceReconciliationResult> {
  const db = drizzle(env.DATABASE, { schema });
  const node = await loadNode(db, input.nodeId);
  requireManagedVmWithoutProviderId(node);
  if (
    input.expectedRuntimeIncarnationId &&
    node.runtimeIncarnationId !== input.expectedRuntimeIncarnationId
  ) {
    throw new ProviderAbsenceReconciliationError(
      `Node ${node.id} runtime incarnation does not match expected value`,
      'not_reconcilable'
    );
  }
  const labels = buildExactLabels(env, node);

  if (node.runtimeTerminationConfirmedAt) {
    return {
      status: 'already_confirmed',
      nodeId: node.id,
      userId: node.userId,
      provider: node.cloudProvider ?? 'unknown',
      credentialSource: node.placementCredentialSource,
      credentialReference: node.placementCredentialReference,
      runtimeIncarnationId: node.runtimeIncarnationId,
      runtimeTerminationConfirmedAt: node.runtimeTerminationConfirmedAt,
      labels,
      providerReturned: 0,
      exactMatches: [],
      nonExactReturned: [],
    };
  }

  const providerResult = await resolveExactProvider(db, env, node);
  const servers = await providerResult.provider.listVMs(labels);
  const exactMatches = servers.filter((server) => exactLabelMatch(server, labels));
  const nonExactReturned = servers.filter((server) => !exactLabelMatch(server, labels));

  if (exactMatches.length > 0) {
    return {
      status: 'exact_match_present',
      nodeId: node.id,
      userId: node.userId,
      provider: providerResult.providerName,
      credentialSource: node.placementCredentialSource,
      credentialReference: node.placementCredentialReference,
      runtimeIncarnationId: node.runtimeIncarnationId,
      runtimeTerminationConfirmedAt: null,
      labels,
      providerReturned: servers.length,
      exactMatches: exactMatches.map(sanitizedVm),
      nonExactReturned: nonExactReturned.map(sanitizedVm),
    };
  }

  const observedAt = new Date().toISOString();
  if (input.confirmAbsence) {
    await markRuntimeTerminationConfirmed(db, node, observedAt);
  }

  return {
    status: input.confirmAbsence ? 'absent_confirmed' : 'absent_observed',
    nodeId: node.id,
    userId: node.userId,
    provider: providerResult.providerName,
    credentialSource: node.placementCredentialSource,
    credentialReference: node.placementCredentialReference,
    runtimeIncarnationId: node.runtimeIncarnationId,
    runtimeTerminationConfirmedAt: input.confirmAbsence ? observedAt : null,
    labels,
    providerReturned: servers.length,
    exactMatches: [],
    nonExactReturned: nonExactReturned.map(sanitizedVm),
  };
}
