/** Recover legacy deployment binding only from positive provider ownership evidence. */
import { hasAmbiguousLabel } from '@simple-agent-manager/providers';
import { type CredentialProvider } from '@simple-agent-manager/shared';
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
import {
  type ExactProviderCredentialBinding,
  fingerprintEncryptedProviderCredential,
} from './provider-credential-exact';
import { createProviderForUser } from './provider-credentials';

export async function recoverLegacyDeploymentBinding(
  env: Env,
  node: schema.Node,
  signal?: AbortSignal
): Promise<boolean> {
  if (
    node.nodeRole !== 'deployment' ||
    node.nodeClass !== 'managed' ||
    node.runtime !== 'vm' ||
    !node.providerInstanceId ||
    !node.cloudProvider ||
    !node.agentReadyAt ||
    node.placementCredentialSource ||
    node.placementCredentialReference ||
    node.placementCredentialVersion ||
    node.placementCredentialFingerprint ||
    !node.credentialAttributionUserId ||
    !node.credentialAttributionSource
  )
    return false;
  const db = drizzle(env.DATABASE, { schema });
  const source = node.credentialAttributionSource;
  const attributionUserId = node.credentialAttributionUserId;
  const projectId = source === 'project' ? node.credentialAttributionProjectId : null;
  if (attributionUserId !== node.userId || (source === 'project' && !projectId)) return false;
  const rows =
    source === 'platform'
      ? await db
          .select()
          .from(schema.platformCredentials)
          .where(
            and(
              eq(schema.platformCredentials.credentialType, 'cloud-provider'),
              eq(schema.platformCredentials.provider, node.cloudProvider),
              eq(schema.platformCredentials.isEnabled, true)
            )
          )
          .limit(2)
      : await db
          .select()
          .from(schema.credentials)
          .where(
            and(
              eq(schema.credentials.userId, attributionUserId),
              eq(schema.credentials.credentialType, 'cloud-provider'),
              eq(schema.credentials.provider, node.cloudProvider),
              eq(schema.credentials.isActive, true),
              projectId
                ? eq(schema.credentials.projectId, projectId)
                : isNull(schema.credentials.projectId)
            )
          )
          .limit(2);
  if (!['user', 'project', 'platform'].includes(source) || rows.length !== 1) return false;
  const credential = rows[0];
  if (!credential) return false;
  const fingerprint = await fingerprintEncryptedProviderCredential(
    credential.encryptedToken,
    credential.iv
  );
  const binding: ExactProviderCredentialBinding = {
    credentialSource: source as 'user' | 'project' | 'platform',
    credentialReference: `${source === 'platform' ? 'platform_credentials' : 'credentials'}:${credential.id}`,
    credentialVersion: Date.parse(credential.updatedAt),
    credentialFingerprint: fingerprint,
  };
  const resolved = await createProviderForUser(
    db,
    attributionUserId,
    getCredentialEncryptionKey(env),
    env,
    node.cloudProvider as CredentialProvider,
    projectId,
    binding
  );
  if (!resolved || resolved.providerName !== node.cloudProvider) return false;
  const vm = await resolved.provider.getVM(
    node.providerInstanceId,
    signal ? { signal } : undefined
  );
  // A wrong-account 404 is NEVER absence proof and never creates a binding.
  if (
    !vm ||
    vm.id !== node.providerInstanceId ||
    vm.location !== node.vmLocation ||
    vm.ip !== node.ipAddress ||
    Date.parse(vm.createdAt) < Date.parse(node.createdAt) ||
    Date.parse(vm.createdAt) > Date.parse(node.agentReadyAt) ||
    !Number.isFinite(Date.parse(vm.createdAt)) ||
    !Number.isFinite(Date.parse(node.createdAt)) ||
    !Number.isFinite(Date.parse(node.agentReadyAt))
  )
    return false;
  const environmentLabel = resolveEnvironmentLabel(env);
  const installationId = resolveInstallationId(env);
  if (
    !environmentLabel ||
    !installationId ||
    hasAmbiguousLabel(vm.labels, 'incarnation') ||
    (!node.runtimeIncarnationId && vm.labels.incarnation !== undefined)
  )
    return false;
  const labels = buildNodeProviderLabels({
    nodeId: node.id,
    isDeploymentNode: true,
    environmentLabel,
    installationId,
    runtimeIncarnationId: node.runtimeIncarnationId ?? undefined,
  });
  for (const [key, value] of Object.entries(labels)) {
    // Old deployments predate installation/incarnation labels. Positive node,
    // role and managed labels plus persisted instance/IP/boot window remain
    // mandatory; any optional label that IS present must match exactly.
    if (
      hasAmbiguousLabel(vm.labels, key) ||
      ((['node', 'role', 'managed'].includes(key) || vm.labels[key] !== undefined) &&
        vm.labels[key] !== value)
    )
      return false;
  }
  const credentialTable = source === 'platform' ? schema.platformCredentials : schema.credentials;
  const credentialFence = and(
    eq(credentialTable.id, credential.id),
    eq(credentialTable.encryptedToken, credential.encryptedToken),
    eq(credentialTable.iv, credential.iv),
    eq(credentialTable.updatedAt, credential.updatedAt)
  );
  const result = await db
    .update(schema.nodes)
    .set({
      placementCredentialSource: binding.credentialSource,
      placementCredentialReference: binding.credentialReference,
      placementCredentialVersion: binding.credentialVersion,
      placementCredentialFingerprint: fingerprint,
    })
    .where(
      and(
        eq(schema.nodes.id, node.id),
        eq(schema.nodes.userId, node.userId),
        eq(schema.nodes.status, node.status),
        sql`${schema.nodes.cloudProvider} IS ${node.cloudProvider}`,
        sql`${schema.nodes.ipAddress} IS ${node.ipAddress}`,
        sql`${schema.nodes.vmLocation} IS ${node.vmLocation}`,
        sql`${schema.nodes.createdAt} IS ${node.createdAt}`,
        sql`${schema.nodes.agentReadyAt} IS ${node.agentReadyAt}`,
        sql`EXISTS (SELECT 1 FROM ${credentialTable} WHERE ${credentialFence})`,
        eq(schema.nodes.nodeRole, 'deployment'),
        eq(schema.nodes.nodeClass, 'managed'),
        eq(schema.nodes.runtime, 'vm'),
        eq(schema.nodes.providerInstanceId, node.providerInstanceId),
        sql`${schema.nodes.runtimeIncarnationId} IS ${node.runtimeIncarnationId}`,
        sql`${schema.nodes.credentialAttributionUserId} IS ${node.credentialAttributionUserId}`,
        sql`${schema.nodes.credentialAttributionProjectId} IS ${node.credentialAttributionProjectId}`,
        sql`${schema.nodes.credentialAttributionSource} IS ${node.credentialAttributionSource}`,
        isNull(schema.nodes.placementCredentialSource),
        isNull(schema.nodes.placementCredentialReference),
        isNull(schema.nodes.placementCredentialVersion),
        isNull(schema.nodes.placementCredentialFingerprint)
      )
    )
    .run();
  return result.meta.changes === 1;
}
